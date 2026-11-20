import json
import math
from types import SimpleNamespace

import pytest
from google.genai import errors, types

from worker.ai import GeminiAI
from worker.config import load_settings, prompts_dir
from worker.errors import PermanentError, RetryableError
from worker.main import handle
from tests.fakes import Harness, envelope, html, settings

DOC = "6fdcdf13dab4fd7a4bb858edd6684fd2"


# ------------------------------------------------------------------ handler


def test_handler_status_codes():
    h = Harness()
    assert handle({}, h.deps)[1] == 204  # malformed envelope: ack, never retry
    assert handle(envelope({"schemaVersion": 1}), h.deps)[1] == 204  # wrong schema: ack and log
    assert handle(envelope(h.message(DOC, b"x")), h.deps)[1] == 503  # stub not written yet: retry

    h.stub(DOC, "https://example.in/news/a")
    body, code = handle(envelope(h.message(DOC, html("मेट्रो", "पुणे शहरात नवीन मेट्रो मार्गाचे काम अंतिम टप्प्यात आहे आणि तो पुढील वर्षी सुरू होईल असे सांगितले."))), h.deps)
    assert code == 200 and body["status"] == "processed"


def test_unexpected_errors_return_500_and_are_logged():
    h = Harness()
    h.stub(DOC, "https://example.in/news/a")

    def boom(*a, **k):
        raise KeyError("bug")

    h.ai.clean = boom
    _, code = handle(envelope(h.message(DOC, html("T", "x" * 100))), h.deps)
    assert code == 500
    assert h.logs[-1]["event"] == "unexpected_error"


# ----------------------------------------------------------------- GeminiAI


class FakeModels:
    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []

    def _next(self, kind, **kw):
        self.requests.append((kind, kw))
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    def generate_content(self, **kw):
        return self._next("generate", **kw)

    def embed_content(self, **kw):
        return self._next("embed", **kw)

    def count_tokens(self, **kw):
        return self._next("count", **kw)


def ai_with(replies, **over):
    client = SimpleNamespace(models=FakeModels(replies))
    return GeminiAI(settings(**over), client=client, gemma_client=client, sleep=lambda s: None), client.models


def api_error(code):
    return errors.APIError(code, {"error": {"code": code, "message": "x", "status": "X"}})


GOOD = json.dumps({"title": "T", "language": "mr", "script": "Deva", "body": "मजकूर", "contentType": "news", "qualityScore": 0.8})


def test_clean_retries_once_with_the_validation_error():
    ai, models = ai_with([SimpleNamespace(text='{"title": ""}'), SimpleNamespace(text=GOOD)])
    out = ai.clean("text", {"Source URL": "https://e.in"})
    assert out.language == "mr"
    second_prompt = models.requests[1][1]["contents"]
    assert "previous reply was not valid" in second_prompt
    cfg = models.requests[0][1]["config"]
    assert cfg.response_mime_type == "application/json" and cfg.system_instruction


def test_clean_invalid_twice_is_permanent():
    ai, _ = ai_with([SimpleNamespace(text="nope"), SimpleNamespace(text="still nope")])
    with pytest.raises(PermanentError) as e:
        ai.clean("text", {})
    assert e.value.code == "invalid_model_output"


def test_rate_limits_back_off_then_become_retryable():
    ai, models = ai_with([api_error(429), api_error(503), SimpleNamespace(text="SAME")])
    assert ai.same_article("a", "b") is True
    ai, _ = ai_with([api_error(429)] * 3)
    with pytest.raises(RetryableError):
        ai.same_article("a", "b")
    ai, _ = ai_with([api_error(400)])
    with pytest.raises(PermanentError):
        ai.ocr(b"x", "image/png")


def test_safety_label_parsing():
    for reply, want in [("ok", "ok"), ("Label: PII-heavy", "pii_heavy"), ("hate", "hate"), ("I cannot say", None)]:
        ai, _ = ai_with([SimpleNamespace(text=reply)])
        assert ai.safety_label("text") == want


def test_embeddings_are_normalised_and_batched():
    vec = [3.0] * 768
    resp = SimpleNamespace(embeddings=[SimpleNamespace(values=vec), SimpleNamespace(values=vec)])
    ai, models = ai_with([resp], embed_batch=2)
    out = ai.embed(["a", "b"], "Title")
    assert len(out) == 2 and math.isclose(sum(x * x for x in out[0]), 1.0, rel_tol=1e-9)
    cfg = models.requests[0][1]["config"]
    assert cfg.task_type == "RETRIEVAL_DOCUMENT" and cfg.output_dimensionality == 768


def test_embedding_falls_back_to_one_input_per_request():
    one = SimpleNamespace(embeddings=[SimpleNamespace(values=[1.0] * 768)])
    ai, models = ai_with([api_error(400), one, one], embed_batch=100)
    assert len(ai.embed(["a", "b"], "T")) == 2
    assert len(models.requests) == 3


def test_clean_prompt_schema_is_accepted_by_the_sdk():
    spec = json.loads((prompts_dir() / "clean.v1.json").read_text(encoding="utf-8"))
    types.GenerateContentConfig(response_mime_type="application/json", response_schema=spec["responseSchema"])


def test_settings_read_models_json():
    s = load_settings({"GOOGLE_CLOUD_PROJECT": "fs-dev"})
    assert s.raw_bucket == "fs-dev-raw" and s.embedding_dims == 768
    assert s.model_flash and s.model_embedding
