"""FairSource data model for the worker (schema version 2).

Mirrors packages/shared/src/schema.ts; change both together.
The worker never mints document IDs: it takes docId from the content.raw message.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

SCHEMA_VERSION = 2

Use = Literal["rag", "training"]
Territory = Literal["IN", "GLOBAL"]
SafetyLabel = Literal["ok", "adult", "hate", "pii_heavy"]
DocumentStatus = Literal["queued", "processing", "done", "failed", "withdrawn"]
RawReason = Literal["new", "changed", "backfill", "manual_sync"]
ContentType = Literal["news", "opinion", "feature", "book", "other"]


def chunk_id_for(doc_id: str, version: int, n: int) -> str:
    """Must match chunkIdFor in schema.ts."""
    return f"{doc_id}_v{version}_{n}"


class ContentRawMessage(BaseModel):
    schemaVersion: Literal[2]
    docId: str
    identityKey: str
    contentHash: str
    publisherId: str
    sourceId: str
    rawUri: str
    mimeType: str
    sourceUrl: Optional[str] = None
    sourceModifiedAt: Optional[datetime] = None
    reason: RawReason
    fetchedAt: datetime


class ContentProcessedMessage(BaseModel):
    schemaVersion: Literal[2] = 2
    docId: str
    version: int
    contentHash: str
    publisherId: str
    status: Literal["done", "failed"]
    servable: bool
    chunkCount: int
    replacedChunkCount: int
    processedAt: datetime


class CleanResult(BaseModel):
    """Gemini Flash output; validated against prompts/clean.v1.json."""

    title: str = Field(min_length=1)
    author: Optional[str] = None
    publishedAt: Optional[str] = None
    language: str = Field(min_length=2, max_length=3)
    script: str = Field(min_length=4, max_length=4)
    body: str
    summary: Optional[str] = None
    topics: list[str] = Field(default_factory=list)
    contentType: ContentType
    qualityScore: float = Field(ge=0, le=1)


class DocumentRecord(BaseModel):
    """documents/{docId} as the worker leaves it after processing a version."""

    id: str
    identityKey: str
    canonicalUrl: Optional[str] = None
    sourceUrl: Optional[str] = None
    guid: Optional[str] = None
    publisherId: str
    sourceId: str
    sourceIds: list[str] = Field(default_factory=list)

    version: int = 1
    contentHash: str
    pendingContentHash: Optional[str] = None

    title: str
    author: Optional[str] = None
    publishedAt: Optional[datetime] = None
    sourceModifiedAt: Optional[datetime] = None
    language: str
    script: str
    topics: list[str] = Field(default_factory=list, max_length=5)
    summary: Optional[str] = None
    contentType: ContentType
    qualityScore: float
    chunkCount: int = 0
    tokenCount: int = 0

    simhash: str
    band0: int
    band1: int
    band2: int
    band3: int
    duplicateOf: Optional[str] = None  # only ever a DIFFERENT docId

    needsReview: bool = False
    safety: SafetyLabel = "ok"
    optOut: bool = False
    servable: bool = False
    status: DocumentStatus
    licenceId: str

    rawUri: Optional[str] = None
    cleanUri: Optional[str] = None

    firstSeenAt: datetime
    lastSeenAt: datetime
    lastCheckedAt: Optional[datetime] = None
    lastHttpStatus: Optional[int] = None
    processedAt: Optional[datetime] = None
    withdrawnAt: Optional[datetime] = None
    withdrawnReason: Optional[
        Literal["http_404", "http_410", "publisher_removed", "source_disconnected"]
    ] = None

    cleanHash: Optional[str] = None
    processedFetchedAt: Optional[datetime] = None
    processingError: Optional[str] = None


class DocumentVersion(BaseModel):
    """documents/{docId}/versions/{version}"""

    version: int
    contentHash: str
    rawUri: Optional[str] = None
    cleanUri: Optional[str] = None
    chunkCount: int
    tokenCount: int
    licenceId: str
    processedAt: datetime
    supersededAt: Optional[datetime] = None


class Chunk(BaseModel):
    """chunks/{docId}_v{version}_{n}"""

    id: str
    documentId: str
    documentVersion: int
    n: int
    publisherId: str
    text: str
    tokenCount: int
    embedding: list[float] = Field(min_length=768, max_length=768)
    language: str
    servable: bool
    optOut: bool
    uses: list[Use]
    territories: list[Territory]
    licenceId: str
    licenceVersion: int
