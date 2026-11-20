// In-memory Store, Blobs and Bus, for tests and for running ingest locally
// without Google Cloud (INGEST_BACKEND=memory).

import type { ContentRawMessage, Source } from '@fairsource/shared';
import type { Blobs, Bus, DocLike, DocSummary, Store } from './ports.js';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  sources = new Map<string, Source>();
  documents = new Map<string, DocLike>();
  /** Written by the worker in production; tests add them directly. */
  chunks = new Map<string, { documentId: string }>();
  versions = new Map<string, Array<{ version: number; rawUri: string | null; cleanUri: string | null }>>();

  async getSource(id: string) {
    const s = this.sources.get(id);
    return s ? clone(s) : null;
  }
  async listActiveSources() {
    return [...this.sources.values()].filter((s) => s.status !== 'paused').map(clone);
  }
  async updateSource(id: string, patch: Partial<Source>) {
    const s = this.sources.get(id);
    if (s) this.sources.set(id, { ...s, ...clone(patch) });
  }
  async acquireLease(id: string, now: Date, until: Date) {
    const s = this.sources.get(id);
    if (!s) return false;
    if (s.leaseUntil && s.leaseUntil > now) return false;
    s.leaseUntil = until;
    return true;
  }
  async releaseLease(id: string) {
    const s = this.sources.get(id);
    if (s) s.leaseUntil = null;
  }
  async adjustItemCount(sourceId: string, delta: number) {
    const s = this.sources.get(sourceId);
    if (s) s.itemCount += delta;
  }

  async getDocument(id: string) {
    const d = this.documents.get(id);
    return d ? clone(d) : null;
  }
  async findBySourceUrl(publisherId: string, url: string) {
    for (const d of this.documents.values()) if (d.publisherId === publisherId && d.sourceUrl === url) return clone(d);
    return null;
  }
  async createDocument(doc: DocLike) {
    if (this.documents.has(doc.id)) throw new Error(`document ${doc.id} already exists`);
    this.documents.set(doc.id, clone(doc));
  }
  async updateDocument(id: string, patch: Partial<DocLike>) {
    const d = this.documents.get(id);
    if (!d) throw new Error(`document ${id} not found`);
    this.documents.set(id, { ...d, ...clone(patch) });
  }
  async touchDocument(id: string, sourceId: string, now: Date, sourceModifiedAt?: Date) {
    const d = this.documents.get(id);
    if (!d) return;
    d.lastSeenAt = now;
    if (!d.sourceIds.includes(sourceId)) d.sourceIds.push(sourceId);
    if (sourceModifiedAt) d.sourceModifiedAt = sourceModifiedAt;
  }
  async listLiveDocuments(sourceId: string): Promise<DocSummary[]> {
    return [...this.documents.values()]
      .filter((d) => d.sourceIds.includes(sourceId) && d.status !== 'withdrawn')
      .map(({ id, sourceUrl, canonicalUrl, status, lastCheckedAt, lastSeenAt }) => clone({ id, sourceUrl, canonicalUrl, status, lastCheckedAt, lastSeenAt }));
  }
  async listWithdrawnForCleanup(limit: number) {
    return [...this.documents.values()].filter((d) => d.status === 'withdrawn' && d.cleanedAt === null).slice(0, limit).map(clone);
  }
  async listVersionFiles(docId: string) {
    return clone(this.versions.get(docId) ?? []);
  }
  async deleteChunks(docId: string) {
    let n = 0;
    for (const [id, c] of this.chunks) if (c.documentId === docId && this.chunks.delete(id)) n++;
    return n;
  }
  async clearVersionFiles(docId: string) {
    for (const v of this.versions.get(docId) ?? []) {
      v.rawUri = null;
      v.cleanUri = null;
    }
  }
  async rawFileInUse(publisherId: string, rawUri: string, exceptDocId: string) {
    return [...this.documents.values()].some((d) => d.id !== exceptDocId && d.publisherId === publisherId && d.status !== 'withdrawn' && d.rawUri === rawUri);
  }
}

export class MemoryBlobs implements Blobs {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async putIfAbsent(path: string, bytes: Uint8Array, contentType: string) {
    if (this.objects.has(path)) return 'exists' as const;
    this.objects.set(path, { bytes, contentType });
    return 'created' as const;
  }
  async read(path: string) {
    const o = this.objects.get(path);
    if (!o) throw new Error(`no object at ${path}`);
    return o.bytes;
  }
  async delete(path: string) {
    this.objects.delete(path);
  }
  deleted: string[] = [];
  async deleteUri(uri: string) {
    this.deleted.push(uri);
    this.objects.delete(uri.replace(/^gs:\/\/[^/]+\//, ''));
  }
  async signUpload(path: string, _contentType: string, expires: Date) {
    return `memory://upload/${encodeURIComponent(path)}?expires=${expires.toISOString()}`;
  }
  uri(path: string) {
    return `gs://memory-raw/${path}`;
  }
}

export class MemoryBus implements Bus {
  messages: ContentRawMessage[] = [];
  async publishRaw(msg: ContentRawMessage) {
    this.messages.push(clone(msg));
  }
}
