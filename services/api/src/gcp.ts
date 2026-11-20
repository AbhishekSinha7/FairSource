// Production adapters for the API: Firestore (vector search, counters),
// Cloud Storage (clean JSON), Pub/Sub (usage.events -> BigQuery) and Gemini.

import type { Chunk, Licence } from '@fairsource/shared';
import { GoogleGenAI } from '@google/genai';
import { PubSub, type Topic } from '@google-cloud/pubsub';
import { Storage } from '@google-cloud/storage';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import type { ApiConfig } from './config.js';
import type {
  AnswerSource,
  Answerer,
  ApiKeyRecord,
  Blobs,
  BuyerRecord,
  ChunkHit,
  DayUsage,
  DocView,
  Embedder,
  Ledger,
  LedgerRow,
  PublisherView,
  Store,
  UsageCounters,
} from './ports.js';

function revive<T>(v: unknown): T {
  if (v instanceof Timestamp) return v.toDate() as T;
  if (Array.isArray(v)) return v.map(revive) as T;
  if (v && typeof v === 'object' && v.constructor === Object) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)])) as T;
  return v as T;
}

const data = <T>(s: DocumentSnapshot) => revive<T>({ ...s.data(), id: s.id });

export class FirestoreStore implements Store {
  constructor(private db: Firestore) {}

  async getApiKey(prefix: string) {
    const s = await this.db.collection('apiKeys').doc(prefix).get();
    return s.exists ? { ...revive<ApiKeyRecord>(s.data()), prefix } : null;
  }
  async touchApiKey(prefix: string, at: Date) {
    await this.db.collection('apiKeys').doc(prefix).update({ lastUsedAt: at });
  }
  async getBuyer(id: string) {
    const s = await this.db.collection('buyers').doc(id).get();
    return s.exists ? data<BuyerRecord>(s) : null;
  }
  async nearestChunks(vector: number[], limit: number): Promise<ChunkHit[]> {
    const snap = await this.db
      .collection('chunks')
      .where('servable', '==', true)
      .where('optOut', '==', false)
      .findNearest({ vectorField: 'embedding', queryVector: vector, limit, distanceMeasure: 'COSINE', distanceResultField: 'distance' })
      .get();
    return snap.docs.map((s) => {
      const { embedding: _, ...rest } = s.data() as Chunk & { distance: number };
      return { ...revive<ChunkHit>(rest), id: s.id };
    });
  }
  async getDocuments(ids: string[]) {
    const out = new Map<string, DocView>();
    if (!ids.length) return out;
    const snaps = await this.db.getAll(...ids.map((id) => this.db.collection('documents').doc(id)));
    for (const s of snaps) if (s.exists) out.set(s.id, data<DocView>(s));
    return out;
  }
  async activeLicences(publisherIds: string[]) {
    const out = new Map<string, Licence>();
    for (let i = 0; i < publisherIds.length; i += 30) {
      const q = await this.db.collection('licences').where('publisherId', 'in', publisherIds.slice(i, i + 30)).where('active', '==', true).get();
      for (const s of q.docs) {
        const l = data<Licence>(s);
        const cur = out.get(l.publisherId);
        if (!cur || l.version > cur.version) out.set(l.publisherId, l);
      }
    }
    return out;
  }
  async getPublishers(ids: string[]) {
    const out = new Map<string, PublisherView>();
    if (!ids.length) return out;
    for (const s of await this.db.getAll(...ids.map((id) => this.db.collection('publishers').doc(id)))) if (s.exists) out.set(s.id, data<PublisherView>(s));
    return out;
  }
  async recordUsage(u: UsageCounters) {
    const inc = FieldValue.increment;
    const batch = this.db.batch();
    const languages = Object.fromEntries(Object.entries(u.languages).map(([l, t]) => [l, inc(t)]));
    batch.set(
      this.db.collection('buyerUsage').doc(`${u.buyerId}_${u.date}`),
      { buyerId: u.buyerId, date: u.date, tokens: inc(u.tokens), spendMicros: inc(u.amountMicros), requests: inc(1), endpoints: { [u.endpoint]: inc(u.tokens) }, languages },
      { merge: true },
    );
    const publishersSpend: Record<string, unknown> = {};
    const month = u.month.replace('-', '');
    for (const d of u.documents) {
      publishersSpend[d.publisherId] = { tokens: inc(d.tokens), spendMicros: inc(d.grossMicros) };
      // "Top articles": per document per month.
      batch.set(
        this.db.collection('documentUsage').doc(`${d.documentId}_${month}`),
        { documentId: d.documentId, publisherId: d.publisherId, month: u.month, title: d.title, language: d.language, uses: inc(1), tokens: inc(d.tokens), shareMicros: inc(d.shareMicros) },
        { merge: true },
      );
      // "Recent uses": expireAt drives a Firestore TTL policy (7 days).
      batch.set(this.db.collection('publishers').doc(d.publisherId).collection('recentUses').doc(d.eventId), {
        ts: u.ts,
        title: d.title,
        buyer: u.buyerName,
        endpoint: u.endpoint,
        tokens: d.tokens,
        shareMicros: d.shareMicros,
        expireAt: new Date(u.ts.getTime() + 7 * 24 * 3600 * 1000),
      });
    }
    if (u.documents.length) batch.set(this.db.collection('buyerUsage').doc(`${u.buyerId}_${u.date}`), { publishers: publishersSpend }, { merge: true });
    const day = u.date.replaceAll('-', '');
    for (const e of u.earnings) {
      batch.set(
        this.db.collection('earnings').doc(`${e.publisherId}_${day}`),
        { publisherId: e.publisherId, date: u.date, uses: inc(u.documents.filter((d) => d.publisherId === e.publisherId).length), tokensServed: inc(e.tokens), grossMicros: inc(e.grossMicros), publisherShareMicros: inc(e.shareMicros) },
        { merge: true },
      );
    }
    await batch.commit();
    const ref = this.db.collection('buyers').doc(u.buyerId);
    await this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return;
      const sameMonth = s.get('usageMonth') === u.month;
      tx.update(ref, { usageMonth: u.month, usedTokensThisMonth: sameMonth ? inc(u.tokens) : u.tokens });
    });
  }
  async getBuyerUsage(buyerId: string, from: string, to: string) {
    const q = await this.db.collection('buyerUsage').where('buyerId', '==', buyerId).where('date', '>=', from).where('date', '<=', to).orderBy('date').get();
    return q.docs.map((s) => {
      const { buyerId: _, id: __, ...d } = data<DayUsage & { buyerId: string; id: string }>(s);
      return { ...d, endpoints: d.endpoints ?? {}, languages: d.languages ?? {} };
    });
  }
  async listChunkIds(documentId: string) {
    const q = await this.db.collection('chunks').where('documentId', '==', documentId).select().get();
    return q.docs.map((s) => s.id);
  }
  async updateChunks(ids: string[], patch: Partial<Chunk>) {
    for (let i = 0; i < ids.length; i += 400) {
      const batch = this.db.batch();
      for (const id of ids.slice(i, i + 400)) batch.update(this.db.collection('chunks').doc(id), patch);
      await batch.commit();
    }
  }
  async listDocumentIds(publisherId: string) {
    const q = await this.db.collection('documents').where('publisherId', '==', publisherId).select().get();
    return q.docs.map((s) => s.id);
  }
}

export class GcsBlobs implements Blobs {
  constructor(private storage: Storage) {}
  async readJson(uri: string) {
    const m = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!m) throw new Error(`not a gs:// URI: ${uri}`);
    const [buf] = await this.storage.bucket(m[1]!).file(m[2]!).download();
    return JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
  }
}

export class PubSubLedger implements Ledger {
  constructor(private topic: Topic) {}
  async publish(rows: LedgerRow[]) {
    // One message per row; the usage-to-bq subscription writes each into ledger.usage_events.
    await Promise.all(rows.map((r) => this.topic.publishMessage({ json: r, attributes: { publisherId: r.publisher_id, endpoint: r.endpoint } })));
  }
}

function genai(cfg: ApiConfig): GoogleGenAI {
  const vertex = ['1', 'true', 'yes'].includes((process.env.GOOGLE_GENAI_USE_VERTEXAI ?? '').toLowerCase());
  return vertex ? new GoogleGenAI({ vertexai: true, project: cfg.projectId, location: cfg.location }) : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

export class GeminiEmbedder implements Embedder {
  constructor(
    private ai: GoogleGenAI,
    private cfg: ApiConfig,
  ) {}
  async embedQuery(text: string) {
    const r = await this.ai.models.embedContent({
      model: this.cfg.embeddingModel,
      contents: text,
      config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: this.cfg.embeddingDims },
    });
    const v = r.embeddings?.[0]?.values ?? [];
    if (v.length !== this.cfg.embeddingDims) throw new Error(`embedding has ${v.length} dimensions, expected ${this.cfg.embeddingDims}`);
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
  }
}

const ANSWER_SYSTEM =
  'You answer questions using ONLY the numbered sources provided. Cite every claim with its source number in square brackets, like [1] or [2][3]. ' +
  'If the sources do not answer the question, say that you do not know. Do not use outside knowledge. Do not invent sources. ' +
  'Answer in the language requested, even if the sources are in another language. Keep names and numbers exactly as in the sources.';

export class GeminiAnswerer implements Answerer {
  constructor(
    private ai: GoogleGenAI,
    private cfg: ApiConfig,
  ) {}
  async answer(question: string, sources: AnswerSource[], language: string) {
    const blocks = sources.map((s) => `[${s.n}] ${s.title} (${s.publisher})\n${s.text}`).join('\n\n');
    const r = await this.ai.models.generateContent({
      model: this.cfg.answerModel,
      contents: `Sources:\n\n${blocks}\n\nQuestion: ${question}\nAnswer language (ISO 639-1): ${language}`,
      config: { systemInstruction: ANSWER_SYSTEM, temperature: 0.2 },
    });
    const text = r.text?.trim();
    if (!text) throw new Error('empty answer');
    return text;
  }
}

export function gcpBackend(cfg: ApiConfig) {
  if (!getApps().length) initializeApp({ projectId: cfg.projectId });
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  const ai = genai(cfg);
  return {
    store: new FirestoreStore(db),
    blobs: new GcsBlobs(new Storage({ projectId: cfg.projectId })),
    ledger: new PubSubLedger(new PubSub({ projectId: cfg.projectId }).topic('usage.events')),
    embedder: new GeminiEmbedder(ai, cfg),
    answerer: new GeminiAnswerer(ai, cfg),
  };
}
