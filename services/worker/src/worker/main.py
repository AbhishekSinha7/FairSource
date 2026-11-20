"""Pub/Sub push handler for content.raw.

Response codes decide what Pub/Sub does (push subscriptions treat any non-2xx
as "retry"):
  200  processed, skipped, or failed permanently (document marked failed)
  204  malformed message: acknowledged and logged, retrying can't help
  503  temporary failure: Pub/Sub retries with backoff; after 5 deliveries the
       message goes to content.raw.dlq
  500  unexpected bug: also retried, then dead-lettered
"""

from __future__ import annotations

import base64
import json
import traceback
from typing import Any, Optional

import functions_framework
from pydantic import ValidationError

from worker.errors import RetryableError
from worker.models import SCHEMA_VERSION, ContentRawMessage
from worker.pipeline import Deps, process

_deps: Optional[Deps] = None


def set_deps(deps: Optional[Deps]) -> None:
    global _deps
    _deps = deps


def get_deps() -> Deps:
    global _deps
    if _deps is None:
        from google.cloud import firestore, storage

        from worker.ai import GeminiAI
        from worker.config import load_settings
        from worker.gcp import FirestoreStore, GcsBlobs, PubSubBus

        s = load_settings()
        _deps = Deps(
            settings=s,
            store=FirestoreStore(firestore.Client(project=s.project)),
            blobs=GcsBlobs(storage.Client(project=s.project)),
            bus=PubSubBus(s.project),
            ai=GeminiAI(s),
        )
    return _deps


def handle(envelope: dict[str, Any], deps: Deps) -> tuple[Any, int]:
    message = envelope.get("message") or {}
    data = message.get("data")
    attempt = envelope.get("deliveryAttempt")
    if not data:
        deps.log(severity="ERROR", event="bad_envelope")
        return "", 204
    try:
        msg = ContentRawMessage.model_validate(json.loads(base64.b64decode(data)))
    except (ValidationError, ValueError) as e:
        deps.log(severity="ERROR", event="invalid_message", messageId=message.get("messageId"), error=str(e)[:1000])
        return "", 204

    try:
        out = process(msg, deps)
    except RetryableError as e:
        deps.log(severity="WARNING", event="retry", docId=msg.docId, attempt=attempt, error=str(e))
        return {"status": "retry", "error": str(e)}, 503
    except Exception as e:  # a bug: keep the message (retry, then dead-letter) and log it fully
        deps.log(severity="ERROR", event="unexpected_error", docId=msg.docId, attempt=attempt, error=repr(e), trace=traceback.format_exc()[-4000:])
        return {"status": "error"}, 500

    deps.log(event="processed", docId=msg.docId, reason=msg.reason, outcome=out.status, detail=out.reason, version=out.version, chunks=out.chunks)
    return {"status": out.status, "reason": out.reason, "version": out.version, "chunks": out.chunks}, 200


@functions_framework.http
def pubsub(request):
    if request.method == "GET":
        return {"ok": True, "service": "worker", "schemaVersion": SCHEMA_VERSION}
    return handle(request.get_json(silent=True) or {}, get_deps())
