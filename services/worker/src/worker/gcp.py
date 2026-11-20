"""Production adapters: Firestore, Cloud Storage, Pub/Sub (service account sa-worker)."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Optional

from google.cloud import firestore, pubsub_v1, storage
from google.cloud.firestore_v1.base_query import FieldFilter
from google.cloud.firestore_v1.vector import Vector

from .ports import BuildFn, CommitStatus

# Firestore allows 500 writes per commit; above this, write in phases (see below).
ATOMIC_WRITE_LIMIT = 450


def _split_gs(uri: str) -> tuple[str, str]:
    if not uri.startswith("gs://"):
        raise ValueError(f"not a gs:// URI: {uri}")
    bucket, _, path = uri[5:].partition("/")
    return bucket, path


def _chunk_fields(c: dict[str, Any]) -> dict[str, Any]:
    out = dict(c)
    out.pop("id", None)
    out["embedding"] = Vector(c["embedding"])
    return out


class FirestoreStore:
    def __init__(self, db: firestore.Client):
        self.db = db
        self.docs = db.collection("documents")
        self.chunks = db.collection("chunks")

    def get_document(self, doc_id: str) -> Optional[dict[str, Any]]:
        snap = self.docs.document(doc_id).get()
        return {**snap.to_dict(), "id": doc_id} if snap.exists else None

    def active_licence(self, publisher_id: str) -> Optional[dict[str, Any]]:
        q = self.db.collection("licences").where(filter=FieldFilter("publisherId", "==", publisher_id)).where(filter=FieldFilter("active", "==", True))
        found = [{**s.to_dict(), "id": s.id} for s in q.stream()]
        return max(found, key=lambda l: l.get("version", 0)) if found else None

    def band_candidates(self, publisher_id: str, bands: tuple[int, int, int, int], exclude_id: str) -> list[dict[str, Any]]:
        seen: dict[str, dict[str, Any]] = {}
        for i, b in enumerate(bands):
            q = self.docs.where(filter=FieldFilter("publisherId", "==", publisher_id)).where(filter=FieldFilter(f"band{i}", "==", b)).limit(10)
            for s in q.stream():
                d = s.to_dict()
                if s.id != exclude_id and d.get("status") == "done" and s.id not in seen:
                    seen[s.id] = {**d, "id": s.id}
        return list(seen.values())

    def update_document(self, doc_id: str, patch: dict[str, Any]) -> None:
        self.docs.document(doc_id).update(patch)

    def _check(self, snap, fetched_at: datetime, expected_version: int) -> tuple[Optional[CommitStatus], dict[str, Any]]:
        if not snap.exists:
            return "missing", {}
        cur = snap.to_dict()
        if cur.get("status") == "withdrawn":
            return "withdrawn", cur
        done = cur.get("processedFetchedAt")
        if done and done > fetched_at:
            return "stale", cur
        if int(cur.get("version") or 0) != expected_version:
            return "conflict", cur
        return None, cur

    def commit_version(self, doc_id, fetched_at, expected_version, build: BuildFn, version_row, new_version) -> tuple[CommitStatus, int]:
        ref = self.docs.document(doc_id)
        transaction = self.db.transaction()

        @firestore.transactional
        def atomic(tx) -> tuple[CommitStatus, int, Optional[list[dict[str, Any]]], dict[str, Any]]:
            status, cur = self._check(ref.get(transaction=tx), fetched_at, expected_version)
            if status:
                return status, 0, None, {}
            patch, chunks = build(cur)
            if chunks is None:
                tx.update(ref, patch)
                return "committed", 0, None, patch
            old = [s.id for s in tx.get(self.chunks.where(filter=FieldFilter("documentId", "==", doc_id)))]
            new_ids = {c["id"] for c in chunks}
            if len(old) + len(chunks) + 3 > ATOMIC_WRITE_LIMIT:
                return "conflict", -1, chunks, patch  # too big for one commit: caller uses the phased path
            stale = [o for o in old if o not in new_ids]
            for cid in stale:
                tx.delete(self.chunks.document(cid))
            for c in chunks:
                tx.set(self.chunks.document(c["id"]), _chunk_fields(c))
            if version_row is not None:
                tx.set(ref.collection("versions").document(str(new_version)), version_row)
                if expected_version > 0:
                    tx.set(ref.collection("versions").document(str(expected_version)), {"supersededAt": version_row["processedAt"]}, merge=True)
            tx.update(ref, patch)
            return "committed", len(stale), None, patch

        status, replaced, big_chunks, patch = atomic(transaction)
        if replaced != -1:
            return status, replaced
        return self._commit_phased(ref, doc_id, fetched_at, expected_version, big_chunks or [], patch, version_row, new_version)

    def _commit_phased(self, ref, doc_id, fetched_at, expected_version, chunks, patch, version_row, new_version) -> tuple[CommitStatus, int]:
        """Very large documents (long books): not atomic. New chunks are written
        hidden, the document is switched in a transaction (with the same checks),
        then old chunks are deleted and new ones made visible. In between, search
        may briefly miss the document; it never serves a withdrawn or stale one."""
        servable = bool(patch.get("servable"))
        writer = self.db.bulk_writer()
        for c in chunks:
            writer.set(self.chunks.document(c["id"]), {**_chunk_fields(c), "servable": False})
        writer.close()

        transaction = self.db.transaction()

        @firestore.transactional
        def switch(tx) -> Optional[CommitStatus]:
            status, _ = self._check(ref.get(transaction=tx), fetched_at, expected_version)
            if status:
                return status
            if version_row is not None:
                tx.set(ref.collection("versions").document(str(new_version)), version_row)
                if expected_version > 0:
                    tx.set(ref.collection("versions").document(str(expected_version)), {"supersededAt": version_row["processedAt"]}, merge=True)
            tx.update(ref, patch)
            return None

        failed = switch(transaction)
        new_ids = {c["id"] for c in chunks}
        writer = self.db.bulk_writer()
        if failed:
            for cid in new_ids:
                writer.delete(self.chunks.document(cid))
            writer.close()
            return failed, 0
        old = [s.id for s in self.chunks.where(filter=FieldFilter("documentId", "==", doc_id)).stream() if s.id not in new_ids]
        for cid in old:
            writer.delete(self.chunks.document(cid))
        if servable:
            for cid in new_ids:
                writer.update(self.chunks.document(cid), {"servable": True})
        writer.close()
        return "committed", len(old)


class GcsBlobs:
    def __init__(self, client: storage.Client):
        self.client = client

    def read(self, uri: str) -> bytes:
        bucket, path = _split_gs(uri)
        return self.client.bucket(bucket).blob(path).download_as_bytes()

    def read_json(self, uri: str) -> dict[str, Any]:
        return json.loads(self.read(uri))

    def write_json(self, bucket: str, path: str, obj: dict[str, Any]) -> str:
        blob = self.client.bucket(bucket).blob(path)
        blob.upload_from_string(json.dumps(obj, ensure_ascii=False, default=str), content_type="application/json; charset=utf-8")
        return f"gs://{bucket}/{path}"


class PubSubBus:
    def __init__(self, project: str, topic: str = "content.processed"):
        self.publisher = pubsub_v1.PublisherClient()
        self.topic = self.publisher.topic_path(project, topic)

    def publish_processed(self, msg: dict[str, Any]) -> None:
        self.publisher.publish(
            self.topic, json.dumps(msg).encode("utf-8"), publisherId=msg["publisherId"], docId=msg["docId"], status=msg["status"]
        ).result(timeout=30)
