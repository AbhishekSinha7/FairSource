"""One content.raw message -> a processed document version (steps 1-10)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from .config import Settings
from .errors import PermanentError, RetryableError
from .extract import HTML_TYPES, IMAGE_TYPES, PDF, Extracted, extract_html, split_pdf
from .models import CleanResult, ContentProcessedMessage, ContentRawMessage, chunk_id_for
from .ports import AI, Blobs, Bus, Store
from .textutil import bands, hamming, language_agrees, personal_data_count, plan_chunks, sha256_text, simhash64

MIN_TEXT_CHARS = 40
PII_THRESHOLD = 10  # phone numbers + email addresses


@dataclass
class Deps:
    settings: Settings
    store: Store
    blobs: Blobs
    bus: Bus
    ai: AI
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
    log: Callable[..., None] = lambda **kw: print(json.dumps({"service": "worker", **kw}, default=str, ensure_ascii=False), flush=True)


@dataclass
class Outcome:
    status: str  # processed | unchanged_text | skipped | failed
    reason: str = ""
    version: Optional[int] = None
    chunks: int = 0


def _parse_date(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        d = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def process(msg: ContentRawMessage, d: Deps) -> Outcome:
    doc = d.store.get_document(msg.docId)
    if doc is None:
        raise RetryableError("document stub not found yet")  # ingest writes it before publishing
    # Step 1: skip work that is already done or no longer wanted.
    if doc.get("status") == "withdrawn":
        return Outcome("skipped", "withdrawn")
    if doc.get("contentHash") == msg.contentHash and doc.get("status") == "done":
        return Outcome("skipped", "already_processed")
    done_fetch = doc.get("processedFetchedAt")
    if done_fetch and done_fetch > msg.fetchedAt:
        return Outcome("skipped", "stale")

    try:
        return _process(msg, doc, d)
    except PermanentError as e:
        _fail(msg, doc, d, e)
        return Outcome("failed", e.code)


def _extract(msg: ContentRawMessage, raw: bytes, d: Deps) -> Extracted:
    s = d.settings
    mime = msg.mimeType.split(";")[0].strip().lower()
    if mime in HTML_TYPES:
        return extract_html(raw, msg.sourceUrl)
    if mime == PDF:
        parts, total = split_pdf(raw, s.ocr_pages_per_call, s.max_pdf_pages)
        return Extracted("\n\n".join(d.ai.ocr(p, PDF).strip() for p in parts), pages=total, method="ocr")
    if mime in IMAGE_TYPES:
        return Extracted(d.ai.ocr(raw, mime).strip(), pages=1, method="ocr")
    if mime == "text/plain":
        return Extracted(raw.decode("utf-8", errors="replace").strip(), method="text")
    raise PermanentError("unsupported_type", f"can't process {mime}")


def _find_duplicate(msg: ContentRawMessage, title: str, body: str, h: int, d: Deps) -> Optional[str]:
    """Step 6: same publisher, shares a SimHash band, within the Hamming limit, and Gemma says SAME."""
    candidates = d.store.band_candidates(msg.publisherId, bands(h), exclude_id=msg.docId)
    scored = sorted(((hamming(h, int(c["simhash"], 16)), c) for c in candidates if c.get("simhash")), key=lambda x: x[0])
    for distance, c in scored[:3]:
        if distance > d.settings.dedup_max_hamming:
            break
        other = c.get("summary") or ""
        if c.get("cleanUri"):
            try:
                other = d.blobs.read_json(c["cleanUri"]).get("body", other)
            except Exception:  # missing clean file: compare with the summary
                pass
        if d.ai.same_article(f"{title}\n{body}", f"{c.get('title', '')}\n{other}"):
            return c["id"]
    return None


def _process(msg: ContentRawMessage, doc: dict[str, Any], d: Deps) -> Outcome:
    s = d.settings
    # Steps 2-3: load and extract.
    raw = d.blobs.read(msg.rawUri)
    ex = _extract(msg, raw, d)
    if len(ex.text) < MIN_TEXT_CHARS:
        raise PermanentError("no_text", "no readable text found")

    # Step 4: clean and structure.
    hints = {"Source URL": msg.sourceUrl or "", "Feed or file title": str(doc.get("title") or "")}
    hints |= {f"Page {k}": v for k, v in ex.hints.items()}
    cleaned: CleanResult = d.ai.clean(ex.text[: s.max_input_chars], hints)
    body = cleaned.body.strip()
    title = " ".join(cleaned.title.split())
    clean_hash = sha256_text(f"{title}\n{body}")
    prev_version = int(doc.get("version") or 0)

    def keep_pending(cur: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
        if cur.get("pendingContentHash") == msg.contentHash:
            patch["pendingContentHash"] = None
        return patch

    # The page changed but the article didn't (layout, comments): record the hash, keep the version.
    if prev_version > 0 and doc.get("status") == "done" and doc.get("cleanHash") == clean_hash:
        patch = {"contentHash": msg.contentHash, "rawUri": msg.rawUri, "processedFetchedAt": msg.fetchedAt, "processingError": None}
        status, _ = d.store.commit_version(msg.docId, msg.fetchedAt, prev_version, lambda cur: (keep_pending(cur, dict(patch)), None), None, prev_version)
        return Outcome("unchanged_text" if status == "committed" else "skipped", status, prev_version)

    # Step 5: language check.
    needs_review = not language_agrees(body, cleaned.language, cleaned.script)
    no_article = len(body) < MIN_TEXT_CHARS or (cleaned.contentType == "other" and cleaned.qualityScore < 0.2)
    if no_article:
        needs_review = True

    # Step 6: near-duplicates.
    h = simhash64(body)
    b0, b1, b2, b3 = bands(h)
    duplicate_of = None if no_article else _find_duplicate(msg, title, body, h, d)

    # Step 7: safety.
    if personal_data_count(body) >= PII_THRESHOLD:
        safety = "pii_heavy"
    else:
        label = d.ai.safety_label(f"{title}\n{body}")
        safety = label or "ok"
        if label is None:
            needs_review = True  # couldn't read the label: hold it back until a re-run

    # Steps 8-9: chunk and embed.
    plans = [] if no_article else plan_chunks(title, body, s.chunk_min_tokens, s.chunk_max_tokens, s.chunk_overlap_tokens)
    texts = [p.text for p in plans]
    vectors = d.ai.embed(texts, title) if texts else []
    tokens = [((d.ai.count_tokens(t) if s.exact_token_counts else None) or p.estimated_tokens) for p, t in zip(plans, texts)]

    lic = d.store.active_licence(msg.publisherId) or {}
    licence_id = str(lic.get("id") or "")
    version = prev_version + 1
    now = d.now()
    published = _parse_date(cleaned.publishedAt) or _parse_date(ex.hints.get("date")) or doc.get("sourceModifiedAt")

    clean_uri = d.blobs.write_json(
        s.clean_bucket,
        f"{msg.publisherId}/{msg.docId}/v{version}-{msg.contentHash[:12]}.json",
        {
            "docId": msg.docId,
            "version": version,
            "contentHash": msg.contentHash,
            "sourceUrl": msg.sourceUrl,
            "extraction": ex.method,
            "pages": ex.pages,
            **cleaned.model_dump(),
            "title": title,
            "body": body,
        },
    )
    base_servable = not no_article and not needs_review and duplicate_of is None and safety == "ok"

    def build(cur: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        opt_out = bool(cur.get("optOut"))
        servable = base_servable and not opt_out
        patch: dict[str, Any] = {
            "version": version,
            "contentHash": msg.contentHash,
            "title": title,
            "author": cleaned.author,
            "publishedAt": published,
            "language": cleaned.language,
            "script": cleaned.script,
            "topics": cleaned.topics[:5],
            "summary": cleaned.summary,
            "contentType": cleaned.contentType,
            "qualityScore": cleaned.qualityScore,
            "chunkCount": len(plans),
            "tokenCount": sum(tokens),
            "simhash": f"{h:016x}",
            "band0": b0,
            "band1": b1,
            "band2": b2,
            "band3": b3,
            "duplicateOf": duplicate_of,
            "needsReview": needs_review,
            "safety": safety,
            "servable": servable,
            "status": "done",
            "licenceId": licence_id,
            "rawUri": msg.rawUri,
            "cleanUri": clean_uri,
            "cleanHash": clean_hash,
            "processedAt": now,
            "processedFetchedAt": msg.fetchedAt,
            "processingError": None,
        }
        chunks = [
            {
                "id": chunk_id_for(msg.docId, version, n),
                "documentId": msg.docId,
                "documentVersion": version,
                "n": n,
                "publisherId": msg.publisherId,
                "text": texts[n],
                "tokenCount": tokens[n],
                "embedding": vectors[n],
                "language": cleaned.language,
                "servable": servable,
                "optOut": opt_out,
                "uses": list(lic.get("uses") or []),
                "territories": list(lic.get("territories") or []),
                "licenceId": licence_id,
                "licenceVersion": int(lic.get("version") or 0),
            }
            for n in range(len(plans))
        ]
        return keep_pending(cur, patch), chunks

    version_row = {
        "version": version,
        "contentHash": msg.contentHash,
        "rawUri": msg.rawUri,
        "cleanUri": clean_uri,
        "chunkCount": len(plans),
        "tokenCount": sum(tokens),
        "licenceId": licence_id,
        "processedAt": now,
        "supersededAt": None,
    }

    # Step 10: one atomic write, then tell listeners.
    status, replaced = d.store.commit_version(msg.docId, msg.fetchedAt, prev_version, build, version_row, version)
    if status != "committed":
        d.log(event="commit_skipped", docId=msg.docId, status=status)
        return Outcome("skipped", status)

    final = d.store.get_document(msg.docId) or {}
    d.bus.publish_processed(
        ContentProcessedMessage(
            docId=msg.docId,
            version=version,
            contentHash=msg.contentHash,
            publisherId=msg.publisherId,
            status="done",
            servable=bool(final.get("servable", base_servable)),
            chunkCount=len(plans),
            replacedChunkCount=replaced,
            processedAt=now,
        ).model_dump(mode="json")
    )
    return Outcome("processed", "", version, len(plans))


def _fail(msg: ContentRawMessage, doc: dict[str, Any], d: Deps, e: PermanentError) -> None:
    """A new document becomes 'failed'. An edit that fails leaves the current
    version live; only processingError records the problem. pendingContentHash
    stays, so ingest doesn't resend the same broken content every run."""
    patch: dict[str, Any] = {"processingError": f"{e.code}: {e}"[:500], "processedFetchedAt": msg.fetchedAt}
    if int(doc.get("version") or 0) == 0:
        patch |= {"status": "failed", "servable": False}
    d.store.update_document(msg.docId, patch)
    d.log(severity="WARNING", event="processing_failed", docId=msg.docId, code=e.code, error=str(e))
    d.bus.publish_processed(
        ContentProcessedMessage(
            docId=msg.docId,
            version=int(doc.get("version") or 0),
            contentHash=msg.contentHash,
            publisherId=msg.publisherId,
            status="failed",
            servable=bool(doc.get("servable", False)),
            chunkCount=int(doc.get("chunkCount") or 0),
            replacedChunkCount=0,
            processedAt=d.now(),
        ).model_dump(mode="json")
    )
