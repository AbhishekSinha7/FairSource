"""Gemini and Gemma calls (Google GenAI SDK).

Authentication comes from the environment: GOOGLE_GENAI_USE_VERTEXAI=true with
GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION in production (service account),
or GEMINI_API_KEY in development. Gemma is served by the Gemini API, not Vertex:
on Vertex set GEMMA_API_KEY, otherwise the Gemma checks fall back to Flash.
"""

from __future__ import annotations

import importlib
import json
import math
import os
import time
from typing import Any, Callable, Optional, TypeVar

from google import genai
from google.genai import errors, types
from pydantic import ValidationError

from .config import Settings, prompts_dir
from .errors import PermanentError, RetryableError
from .models import CleanResult

T = TypeVar("T")

RETRYABLE = {408, 429, 500, 502, 503, 504}

# Network errors from whichever HTTP library this SDK version uses (httpx2 in 3.x, httpx before).
TRANSPORT_ERRORS: tuple[type[BaseException], ...] = (TimeoutError, ConnectionError)
for _name in ("httpx2", "httpx"):
    try:
        TRANSPORT_ERRORS += (importlib.import_module(_name).TransportError,)
    except (ImportError, AttributeError):
        pass

OCR_PROMPT = (
    "Transcribe all the text on these pages exactly as printed, in reading order "
    "(columns left to right, top to bottom). Keep the original language, script and spelling; "
    "do not translate, summarise or correct anything. Leave out running headers, page numbers "
    "and decorative text. Separate paragraphs with a blank line. Output plain text only."
)

SAME_PROMPT = (
    "Below are two texts from the same publisher.\n"
    "Answer SAME if they are the same article: republished, syndicated, or a lightly edited copy "
    "(for example an AMP, print or mobile version).\n"
    "Answer DIFFERENT if they are different articles, even if they report the same event.\n"
    "Reply with exactly one word: SAME or DIFFERENT.\n\n"
    "Text A:\n{a}\n\nText B:\n{b}"
)

SAFETY_PROMPT = (
    "You label text for a service that licenses publishers' articles to AI companies.\n"
    "Reply with exactly one label:\n"
    "ok - normal journalism, writing or reference text\n"
    "adult - sexually explicit content\n"
    "hate - hate speech or incitement against a group\n"
    "pii_heavy - mainly a list or directory of private people's personal details "
    "(names with phone numbers, home addresses or ID numbers)\n"
    "News that names public figures or quotes people is ok.\n\n"
    "Text:\n{text}"
)

LABELS = ("pii_heavy", "adult", "hate", "ok")


def _vertex() -> bool:
    return os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() in {"1", "true", "yes"}


def _normalise(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class GeminiAI:
    def __init__(
        self,
        settings: Settings,
        client: Optional[genai.Client] = None,
        gemma_client: Optional[genai.Client] = None,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.s = settings
        self.client = client or genai.Client()
        self.sleep = sleep
        if gemma_client is not None:
            self.gemma, self.gemma_model = gemma_client, settings.model_gemma
        elif _vertex():
            key = os.environ.get("GEMMA_API_KEY")
            self.gemma, self.gemma_model = (genai.Client(api_key=key), settings.model_gemma) if key else (self.client, settings.model_flash)
        else:
            self.gemma, self.gemma_model = self.client, settings.model_gemma
        spec = json.loads((prompts_dir() / "clean.v1.json").read_text(encoding="utf-8"))
        self.clean_system: str = spec["systemInstruction"]
        self.clean_schema: dict[str, Any] = spec["responseSchema"]
        self.embed_batch = settings.embed_batch

    # ------------------------------------------------------------ plumbing

    def _call(self, what: str, fn: Callable[[], T]) -> T:
        """3 tries with 2 s / 4 s backoff on temporary errors; then RetryableError
        (Pub/Sub retries the message). Other 4xx errors are permanent."""
        for attempt in range(3):
            try:
                return fn()
            except errors.APIError as e:
                if e.code in RETRYABLE:
                    if attempt < 2:
                        self.sleep(2 ** (attempt + 1))
                        continue
                    raise RetryableError(f"{what}: Gemini {e.code} after 3 tries") from e
                raise PermanentError("model_rejected", f"{what}: Gemini {e.code}: {e.message}") from e
            except TRANSPORT_ERRORS as e:
                if attempt < 2:
                    self.sleep(2 ** (attempt + 1))
                    continue
                raise RetryableError(f"{what}: network error after 3 tries: {e}") from e
        raise AssertionError("unreachable")

    # ---------------------------------------------------------------- steps

    def ocr(self, data: bytes, mime_type: str) -> str:
        resp = self._call(
            "ocr",
            lambda: self.client.models.generate_content(
                model=self.s.model_pro,
                contents=[types.Part.from_bytes(data=data, mime_type=mime_type), OCR_PROMPT],
                config=types.GenerateContentConfig(temperature=0),
            ),
        )
        return (resp.text or "").strip()

    def clean(self, text: str, hints: dict[str, str]) -> CleanResult:
        header = "\n".join(f"{k}: {v}" for k, v in hints.items() if v)
        prompt = f"{header}\n\n---\n{text}"
        extra = ""
        last_error = ""
        for _ in range(2):
            resp = self._call(
                "clean",
                lambda: self.client.models.generate_content(
                    model=self.s.model_flash,
                    contents=prompt + extra,
                    config=types.GenerateContentConfig(
                        system_instruction=self.clean_system,
                        response_mime_type="application/json",
                        response_schema=self.clean_schema,
                        temperature=0,
                    ),
                ),
            )
            try:
                return CleanResult.model_validate_json(resp.text or "")
            except ValidationError as e:
                last_error = str(e)[:800]
                extra = f"\n\n---\nYour previous reply was not valid: {last_error}\nReturn only JSON that matches the schema."
        raise PermanentError("invalid_model_output", f"clean step returned invalid JSON twice: {last_error}")

    def _gemma(self, what: str, prompt: str) -> str:
        resp = self._call(
            what,
            lambda: self.gemma.models.generate_content(model=self.gemma_model, contents=prompt, config=types.GenerateContentConfig(temperature=0)),
        )
        return (resp.text or "").strip()

    def same_article(self, a: str, b: str) -> bool:
        answer = self._gemma("dedup", SAME_PROMPT.format(a=a[:3000], b=b[:3000])).upper()
        return "SAME" in answer and "DIFFERENT" not in answer

    def safety_label(self, text: str) -> Optional[str]:
        answer = self._gemma("safety", SAFETY_PROMPT.format(text=text[:6000])).lower()
        for label in LABELS:
            if label in answer.replace("-", "_"):
                return label
        return None

    def embed(self, texts: list[str], title: str) -> list[list[float]]:
        out: list[list[float]] = []
        i = 0
        while i < len(texts):
            batch = texts[i : i + self.embed_batch]
            try:
                resp = self._call(
                    "embed",
                    lambda: self.client.models.embed_content(
                        model=self.s.model_embedding,
                        contents=batch,
                        config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT", output_dimensionality=self.s.embedding_dims, title=title[:200] or None),
                    ),
                )
            except PermanentError:
                if len(batch) > 1:  # some endpoints take one input per request
                    self.embed_batch = 1
                    continue
                raise
            vectors = [e.values or [] for e in (resp.embeddings or [])]
            if len(vectors) != len(batch) or any(len(v) != self.s.embedding_dims for v in vectors):
                raise RetryableError("embed: unexpected embedding count or size")
            out.extend(_normalise(v) for v in vectors)  # truncated vectors must be re-normalised
            i += len(batch)
        return out

    def count_tokens(self, text: str) -> Optional[int]:
        try:
            resp = self._call("count_tokens", lambda: self.client.models.count_tokens(model=self.s.model_flash, contents=text))
            return resp.total_tokens
        except (PermanentError, RetryableError):
            return None  # fall back to the estimate
