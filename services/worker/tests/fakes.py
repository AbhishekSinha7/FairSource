"""In-memory Store, Blobs, Bus and a scripted AI for pipeline tests."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from worker.config import Settings
from worker.models import CleanResult
from worker.pipeline import Deps
from worker.textutil import guess_language

T0 = datetime(2026, 11, 19, 10, 0, tzinfo=timezone.utc)


class MemoryStore:
    def __init__(self):
        self.documents: dict[str, dict[str, Any]] = {}
        self.chunks: dict[str, dict[str, Any]] = {}
        self.versions: dict[tuple[str, int], dict[str, Any]] = {}
        self.licences: list[dict[str, Any]] = []

    def get_document(self, doc_id):
        d = self.documents.get(doc_id)
        return copy.deepcopy({**d, "id": doc_id}) if d else None

    def active_licence(self, publisher_id):
        found = [l for l in self.licences if l["publisherId"] == publisher_id and l["active"]]
        return copy.deepcopy(max(found, key=lambda l: l["version"])) if found else None

    def band_candidates(self, publisher_id, bands, exclude_id):
        return [
            copy.deepcopy({**d, "id": i})
            for i, d in self.documents.items()
            if i != exclude_id and d.get("publisherId") == publisher_id and d.get("status") == "done" and any(d.get(f"band{k}") == b for k, b in enumerate(bands))
        ]

    def update_document(self, doc_id, patch):
        self.documents[doc_id].update(copy.deepcopy(patch))

    def commit_version(self, doc_id, fetched_at, expected_version, build, version_row, new_version):
        cur = self.documents.get(doc_id)
        if cur is None:
            return "missing", 0
        if cur.get("status") == "withdrawn":
            return "withdrawn", 0
        if cur.get("processedFetchedAt") and cur["processedFetchedAt"] > fetched_at:
            return "stale", 0
        if int(cur.get("version") or 0) != expected_version:
            return "conflict", 0
        patch, chunks = build(copy.deepcopy(cur))
        replaced = 0
        if chunks is not None:
            new_ids = {c["id"] for c in chunks}
            for cid in [c for c, v in self.chunks.items() if v["documentId"] == doc_id and c not in new_ids]:
                del self.chunks[cid]
                replaced += 1
            for c in chunks:
                self.chunks[c["id"]] = copy.deepcopy(c)
            if version_row is not None:
                self.versions[(doc_id, new_version)] = copy.deepcopy(version_row)
                if expected_version > 0:
                    self.versions.setdefault((doc_id, expected_version), {})["supersededAt"] = version_row["processedAt"]
        cur.update(copy.deepcopy(patch))
        return "committed", replaced

    def chunks_of(self, doc_id):
        return sorted((c for c in self.chunks.values() if c["documentId"] == doc_id), key=lambda c: c["n"])


class MemoryBlobs:
    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def put(self, uri: str, data: bytes):
        self.objects[uri] = data

    def read(self, uri):
        if uri not in self.objects:
            raise FileNotFoundError(uri)
        return self.objects[uri]

    def read_json(self, uri):
        return json.loads(self.read(uri))

    def write_json(self, bucket, path, obj):
        uri = f"gs://{bucket}/{path}"
        self.objects[uri] = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        return uri


class MemoryBus:
    def __init__(self):
        self.messages: list[dict[str, Any]] = []

    def publish_processed(self, msg):
        self.messages.append(msg)


class FakeAI:
    """Deterministic stand-in for Gemini/Gemma. clean() keeps the text, uses the
    first line as the title and guesses the language locally (overridable)."""

    def __init__(self):
        self.calls: list[str] = []
        self.ocr_text = "ओसीआर केलेला मजकूर येथे आहे. " * 20
        self.language: Optional[str] = None
        self.same = False
        self.safety: Optional[str] = "ok"
        self.invalid_clean = False

    def ocr(self, data, mime_type):
        self.calls.append(f"ocr:{mime_type}")
        return self.ocr_text

    def clean(self, text, hints):
        self.calls.append("clean")
        if self.invalid_clean:
            from worker.errors import PermanentError

            raise PermanentError("invalid_model_output", "clean step returned invalid JSON twice")
        lines = [l for l in text.splitlines() if l.strip()]
        title = lines[0].strip() if lines else "Untitled"
        body = "\n\n".join(lines[1:]) if len(lines) > 1 else text
        lang = self.language or guess_language(body) or "en"
        return CleanResult(title=title, language=lang, script="Deva" if lang in ("mr", "hi") else "Latn", body=body, summary=body[:120], topics=["pune"], contentType="news", qualityScore=0.9)

    def same_article(self, a, b):
        self.calls.append("same")
        return self.same

    def safety_label(self, text):
        self.calls.append("safety")
        return self.safety

    def embed(self, texts, title):
        self.calls.append(f"embed:{len(texts)}")
        out = []
        for t in texts:
            seed = hashlib.sha256(t.encode()).digest()
            v = [((seed[i % 32] + i) % 17) - 8.0 for i in range(768)]
            n = math.sqrt(sum(x * x for x in v))
            out.append([x / n for x in v])
        return out

    def count_tokens(self, text):
        return None


def settings(**over) -> Settings:
    base = dict(project="fs-test", raw_bucket="fs-test-raw", clean_bucket="fs-test-clean", model_pro="pro", model_flash="flash", model_embedding="emb", model_gemma="gemma", exact_token_counts=False)
    base.update(over)
    return Settings(**base)


class Harness:
    def __init__(self):
        self.store = MemoryStore()
        self.blobs = MemoryBlobs()
        self.bus = MemoryBus()
        self.ai = FakeAI()
        self.clock = T0
        self.logs: list[dict[str, Any]] = []
        self.deps = Deps(settings=settings(), store=self.store, blobs=self.blobs, bus=self.bus, ai=self.ai, now=lambda: self.clock, log=lambda **kw: self.logs.append(kw))
        self.store.licences.append({"id": "lic_1", "publisherId": "pub_1", "active": True, "version": 3, "uses": ["rag"], "territories": ["IN", "GLOBAL"]})
        self._fetch = T0

    def stub(self, doc_id: str, url: str, **over) -> None:
        """What ingest writes before publishing (DocumentStub)."""
        self.store.documents[doc_id] = {
            "identityKey": f"url:{url}", "canonicalUrl": url, "sourceUrl": url, "guid": None, "publisherId": "pub_1",
            "sourceId": "src_1", "sourceIds": ["src_1"], "version": 0, "contentHash": "", "pendingContentHash": None,
            "title": "Feed title", "sourceModifiedAt": None, "optOut": False, "servable": False, "status": "queued",
            "firstSeenAt": T0, "lastSeenAt": T0, "lastCheckedAt": None, "lastHttpStatus": None, "withdrawnAt": None, "withdrawnReason": None,
            **over,
        }

    def message(self, doc_id: str, content: bytes, mime: str = "text/html", url: Optional[str] = "https://example.in/news/a", fetched_at: Optional[datetime] = None) -> dict[str, Any]:
        h = hashlib.sha256(content).hexdigest()
        uri = f"gs://fs-test-raw/pub_1/2026/11/{h}.bin"
        self.blobs.put(uri, content)
        self._fetch = fetched_at or (self._fetch + timedelta(minutes=1))
        if doc_id in self.store.documents:
            self.store.documents[doc_id]["pendingContentHash"] = h
        return {
            "schemaVersion": 2, "docId": doc_id, "identityKey": f"url:{url}", "contentHash": h, "publisherId": "pub_1", "sourceId": "src_1",
            "rawUri": uri, "mimeType": mime, "sourceUrl": url, "sourceModifiedAt": None, "reason": "new", "fetchedAt": self._fetch.isoformat(),
        }


def envelope(msg: dict[str, Any], attempt: int = 1) -> dict[str, Any]:
    return {"message": {"data": base64.b64encode(json.dumps(msg).encode()).decode(), "messageId": "m1"}, "deliveryAttempt": attempt}


def html(title: str, *paragraphs: str) -> bytes:
    body = "".join(f"<p>{p}</p>" for p in paragraphs)
    return f"<html><head><title>{title}</title></head><body><nav>Home | News</nav><article><h1>{title}</h1>{body}</article><footer>© Example</footer></body></html>".encode()
