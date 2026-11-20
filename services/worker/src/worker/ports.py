"""What the pipeline needs from the outside world. gcp.py implements these for
production; tests/fakes.py implements them in memory."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Literal, Optional, Protocol

from .models import CleanResult

CommitStatus = Literal["committed", "stale", "withdrawn", "conflict", "missing"]

# build(current_document) -> (document patch, chunks to write or None to keep the current ones)
BuildFn = Callable[[dict[str, Any]], tuple[dict[str, Any], Optional[list[dict[str, Any]]]]]


class Store(Protocol):
    def get_document(self, doc_id: str) -> Optional[dict[str, Any]]: ...

    def active_licence(self, publisher_id: str) -> Optional[dict[str, Any]]: ...

    def band_candidates(self, publisher_id: str, bands: tuple[int, int, int, int], exclude_id: str) -> list[dict[str, Any]]:
        """Processed, non-withdrawn documents of this publisher sharing at least one SimHash band."""
        ...

    def update_document(self, doc_id: str, patch: dict[str, Any]) -> None: ...

    def commit_version(
        self,
        doc_id: str,
        fetched_at: datetime,
        expected_version: int,
        build: BuildFn,
        version_row: Optional[dict[str, Any]],
        new_version: int,
    ) -> tuple[CommitStatus, int]:
        """Atomically, re-reading the document first:
        - 'missing' if it doesn't exist, 'withdrawn' if withdrawn meanwhile,
          'stale' if a newer fetch was already processed, 'conflict' if its
          version is no longer `expected_version`;
        - otherwise apply build(current): update the document and, when chunks
          are given, write them, delete the document's other chunks, add
          versions/{new_version} and mark versions/{expected_version} superseded.
        Returns the status and the number of old chunks deleted."""
        ...


class Blobs(Protocol):
    def read(self, uri: str) -> bytes: ...

    def read_json(self, uri: str) -> dict[str, Any]: ...

    def write_json(self, bucket: str, path: str, obj: dict[str, Any]) -> str:
        """Returns the gs:// URI."""
        ...


class Bus(Protocol):
    def publish_processed(self, msg: dict[str, Any]) -> None: ...


class AI(Protocol):
    def ocr(self, data: bytes, mime_type: str) -> str: ...

    def clean(self, text: str, hints: dict[str, str]) -> CleanResult: ...

    def same_article(self, a: str, b: str) -> bool: ...

    def safety_label(self, text: str) -> Optional[str]:
        """'ok' | 'adult' | 'hate' | 'pii_heavy', or None when the answer can't be read."""
        ...

    def embed(self, texts: list[str], title: str) -> list[list[float]]: ...

    def count_tokens(self, text: str) -> Optional[int]: ...
