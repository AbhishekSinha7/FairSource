// What ingest needs from Firestore, Cloud Storage and Pub/Sub. gcp.ts implements
// these for production; memory.ts implements them for tests and local dev.

import type { ContentRawMessage, DocumentStub, Source } from '@fairsource/shared';

export type DocLike = DocumentStub;

/** Fields the sweep needs for each live document. */
export type DocSummary = Pick<DocLike, 'id' | 'sourceUrl' | 'canonicalUrl' | 'status' | 'lastCheckedAt' | 'lastSeenAt'>;

export interface Store {
  getSource(id: string): Promise<Source | null>;
  listActiveSources(): Promise<Source[]>;
  updateSource(id: string, patch: Partial<Source>): Promise<void>;
  /** Atomically take the source's lease if it is free or expired. */
  acquireLease(id: string, now: Date, until: Date): Promise<boolean>;
  releaseLease(id: string): Promise<void>;
  adjustItemCount(sourceId: string, delta: number): Promise<void>;

  getDocument(id: string): Promise<DocLike | null>;
  findBySourceUrl(publisherId: string, url: string): Promise<DocLike | null>;
  createDocument(doc: DocLike): Promise<void>;
  updateDocument(id: string, patch: Partial<DocLike>): Promise<void>;
  /** Sets lastSeenAt and adds sourceId to sourceIds. */
  touchDocument(id: string, sourceId: string, now: Date, sourceModifiedAt?: Date): Promise<void>;
  /** Documents that list this source, excluding withdrawn ones. */
  listLiveDocuments(sourceId: string): Promise<DocSummary[]>;

  // Cleanup of withdrawn documents
  /** Withdrawn documents whose stored content hasn't been deleted yet (cleanedAt == null). */
  listWithdrawnForCleanup(limit: number): Promise<DocLike[]>;
  /** Raw and clean file URIs of every processed version. */
  listVersionFiles(docId: string): Promise<Array<{ version: number; rawUri: string | null; cleanUri: string | null }>>;
  /** Deletes the document's chunks; returns how many. */
  deleteChunks(docId: string): Promise<number>;
  /** Clears rawUri/cleanUri on the version rows (hashes and counts stay). */
  clearVersionFiles(docId: string): Promise<void>;
  /** True if another non-withdrawn document still points at this raw file. */
  rawFileInUse(publisherId: string, rawUri: string, exceptDocId: string): Promise<boolean>;
}

export interface Blobs {
  /** Create-only write. 'exists' when an object is already at that path. */
  putIfAbsent(path: string, bytes: Uint8Array, contentType: string): Promise<'created' | 'exists'>;
  read(path: string): Promise<Uint8Array>;
  delete(path: string): Promise<void>;
  /** Delete by full gs:// URI, in any bucket (raw or clean). Missing objects are fine. */
  deleteUri(uri: string): Promise<void>;
  signUpload(path: string, contentType: string, expires: Date): Promise<string>;
  uri(path: string): string;
}

export interface Bus {
  publishRaw(msg: ContentRawMessage): Promise<void>;
}
