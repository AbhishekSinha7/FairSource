// Production adapters: Firestore, Cloud Storage, Pub/Sub.
// Credentials come from the Cloud Run service account (sa-ingest); no keys.

import type { ContentRawMessage, Source } from '@fairsource/shared';
import { PubSub, type Topic } from '@google-cloud/pubsub';
import { Storage, type Bucket } from '@google-cloud/storage';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { IngestConfig } from './config.js';
import type { Blobs, Bus, DocLike, DocSummary, Store } from './ports.js';

/** Firestore Timestamps -> Date, recursively. */
function revive<T>(v: unknown): T {
  if (v instanceof Timestamp) return v.toDate() as T;
  if (Array.isArray(v)) return v.map(revive) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)])) as T;
  return v as T;
}

const ALREADY_EXISTS = 6;

export class FirestoreStore implements Store {
  constructor(private db: Firestore) {}
  private sources = () => this.db.collection('sources');
  private documents = () => this.db.collection('documents');

  async getSource(id: string) {
    const s = await this.sources().doc(id).get();
    return s.exists ? revive<Source>({ ...s.data(), id: s.id }) : null;
  }
  async listActiveSources() {
    const q = await this.sources().where('status', 'in', ['active', 'error']).get();
    return q.docs.map((d) => revive<Source>({ ...d.data(), id: d.id }));
  }
  async updateSource(id: string, patch: Partial<Source>) {
    await this.sources().doc(id).update(patch);
  }
  async acquireLease(id: string, now: Date, until: Date) {
    const ref = this.sources().doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const lease = revive<Date | null>(snap.get('leaseUntil') ?? null);
      if (lease && lease > now) return false;
      tx.update(ref, { leaseUntil: until });
      return true;
    });
  }
  async releaseLease(id: string) {
    await this.sources().doc(id).update({ leaseUntil: null });
  }
  async adjustItemCount(sourceId: string, delta: number) {
    await this.sources().doc(sourceId).update({ itemCount: FieldValue.increment(delta) });
  }

  async getDocument(id: string) {
    const d = await this.documents().doc(id).get();
    return d.exists ? revive<DocLike>({ ...d.data(), id: d.id }) : null;
  }
  async findBySourceUrl(publisherId: string, url: string) {
    const q = await this.documents().where('publisherId', '==', publisherId).where('sourceUrl', '==', url).limit(1).get();
    const d = q.docs[0];
    return d ? revive<DocLike>({ ...d.data(), id: d.id }) : null;
  }
  async createDocument(doc: DocLike) {
    try {
      await this.documents().doc(doc.id).create(doc);
    } catch (e) {
      if ((e as { code?: number }).code !== ALREADY_EXISTS) throw e; // another run created it first
    }
  }
  async updateDocument(id: string, patch: Partial<DocLike>) {
    await this.documents().doc(id).update(patch);
  }
  async touchDocument(id: string, sourceId: string, now: Date, sourceModifiedAt?: Date) {
    await this.documents()
      .doc(id)
      .update({ lastSeenAt: now, sourceIds: FieldValue.arrayUnion(sourceId), ...(sourceModifiedAt ? { sourceModifiedAt } : {}) });
  }
  async listLiveDocuments(sourceId: string): Promise<DocSummary[]> {
    const q = await this.documents().where('sourceIds', 'array-contains', sourceId).select('sourceUrl', 'canonicalUrl', 'status', 'lastCheckedAt', 'lastSeenAt').get();
    return q.docs
      .map((d) => revive<DocSummary>({ ...d.data(), id: d.id }))
      .filter((d) => d.status !== 'withdrawn');
  }

  async listWithdrawnForCleanup(limit: number) {
    const q = await this.documents().where('status', '==', 'withdrawn').where('cleanedAt', '==', null).limit(limit).get();
    return q.docs.map((d) => revive<DocLike>({ ...d.data(), id: d.id }));
  }
  async listVersionFiles(docId: string) {
    const q = await this.documents().doc(docId).collection('versions').get();
    return q.docs.map((v) => ({ version: Number(v.id), rawUri: (v.get('rawUri') as string | null) ?? null, cleanUri: (v.get('cleanUri') as string | null) ?? null }));
  }
  async deleteChunks(docId: string) {
    const q = await this.db.collection('chunks').where('documentId', '==', docId).select().get();
    const writer = this.db.bulkWriter();
    for (const c of q.docs) void writer.delete(c.ref);
    await writer.close();
    return q.size;
  }
  async clearVersionFiles(docId: string) {
    const q = await this.documents().doc(docId).collection('versions').select().get();
    const batch = this.db.batch();
    for (const v of q.docs) batch.update(v.ref, { rawUri: null, cleanUri: null });
    await batch.commit();
  }
  async rawFileInUse(publisherId: string, rawUri: string, exceptDocId: string) {
    const q = await this.documents().where('publisherId', '==', publisherId).where('rawUri', '==', rawUri).select('status').limit(5).get();
    return q.docs.some((d) => d.id !== exceptDocId && d.get('status') !== 'withdrawn');
  }
}

export class GcsBlobs implements Blobs {
  constructor(private bucket: Bucket) {}

  async putIfAbsent(path: string, bytes: Uint8Array, contentType: string) {
    try {
      await this.bucket.file(path).save(Buffer.from(bytes), { contentType, resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
      return 'created' as const;
    } catch (e) {
      if ((e as { code?: number }).code === 412) return 'exists' as const;
      throw e;
    }
  }
  async read(path: string) {
    const [buf] = await this.bucket.file(path).download();
    return new Uint8Array(buf);
  }
  async delete(path: string) {
    await this.bucket.file(path).delete({ ignoreNotFound: true });
  }
  async deleteUri(uri: string) {
    const m = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!m) return;
    await this.bucket.storage.bucket(m[1]!).file(m[2]!).delete({ ignoreNotFound: true });
  }
  async signUpload(path: string, contentType: string, expires: Date) {
    // Needs roles/iam.serviceAccountTokenCreator for sa-ingest on itself (infra/setup.sh).
    const [url] = await this.bucket.file(path).getSignedUrl({ version: 'v4', action: 'write', expires, contentType });
    return url;
  }
  uri(path: string) {
    return `gs://${this.bucket.name}/${path}`;
  }
}

export class PubSubBus implements Bus {
  constructor(private topic: Topic) {}
  async publishRaw(msg: ContentRawMessage) {
    await this.topic.publishMessage({ json: msg, attributes: { publisherId: msg.publisherId, mimeType: msg.mimeType, schemaVersion: String(msg.schemaVersion) } });
  }
}

let db: Firestore | null = null;

export function gcpBackend(cfg: IngestConfig): { store: Store; blobs: Blobs; bus: Bus } {
  if (!getApps().length) initializeApp({ projectId: cfg.projectId });
  if (!db) {
    db = getFirestore();
    db.settings({ ignoreUndefinedProperties: true });
  }
  return {
    store: new FirestoreStore(db),
    blobs: new GcsBlobs(new Storage({ projectId: cfg.projectId }).bucket(cfg.rawBucket)),
    bus: new PubSubBus(new PubSub({ projectId: cfg.projectId }).topic('content.raw')),
  };
}
