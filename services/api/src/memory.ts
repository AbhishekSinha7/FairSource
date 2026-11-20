// In-memory backend for tests and for running the API locally (API_BACKEND=memory).

import type { Chunk, Licence } from '@fairsource/shared';
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

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

export class MemoryStore implements Store {
  keys = new Map<string, ApiKeyRecord>();
  buyers = new Map<string, BuyerRecord>();
  chunks = new Map<string, Chunk>();
  documents = new Map<string, DocView>();
  licences: Licence[] = [];
  publishers = new Map<string, PublisherView>();
  usage = new Map<string, DayUsage & { buyerId: string }>();
  earnings = new Map<string, { tokens: number; grossMicros: number; shareMicros: number }>();
  documentUsage = new Map<string, { documentId: string; publisherId: string; month: string; title: string; language: string; uses: number; tokens: number; shareMicros: number }>();
  recentUses = new Map<string, Array<{ ts: Date; title: string; buyer: string; endpoint: string; tokens: number; shareMicros: number }>>();

  async getApiKey(prefix: string) {
    const k = this.keys.get(prefix);
    return k ? { ...k, scopes: [...k.scopes] } : null; // a copy, like Firestore
  }
  async touchApiKey(prefix: string, at: Date) {
    const k = this.keys.get(prefix);
    if (k) k.lastUsedAt = at;
  }
  async getBuyer(id: string) {
    const b = this.buyers.get(id);
    return b ? { ...b } : null;
  }
  async nearestChunks(vector: number[], limit: number): Promise<ChunkHit[]> {
    return [...this.chunks.values()]
      .filter((c) => c.servable && !c.optOut)
      .map(({ embedding, ...c }) => ({ ...c, distance: 1 - dot(vector, embedding) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }
  async getDocuments(ids: string[]) {
    return new Map(ids.filter((id) => this.documents.has(id)).map((id) => [id, { ...this.documents.get(id)! }]));
  }
  async activeLicences(publisherIds: string[]) {
    const out = new Map<string, Licence>();
    for (const l of this.licences) {
      if (!l.active || !publisherIds.includes(l.publisherId)) continue;
      const cur = out.get(l.publisherId);
      if (!cur || l.version > cur.version) out.set(l.publisherId, { ...l });
    }
    return out;
  }
  async getPublishers(ids: string[]) {
    return new Map(ids.filter((id) => this.publishers.has(id)).map((id) => [id, this.publishers.get(id)!]));
  }
  async recordUsage(u: UsageCounters) {
    const key = `${u.buyerId}_${u.date}`;
    const day = this.usage.get(key) ?? { buyerId: u.buyerId, date: u.date, tokens: 0, spendMicros: 0, requests: 0, endpoints: {}, languages: {} };
    day.tokens += u.tokens;
    day.spendMicros += u.amountMicros;
    day.requests += 1;
    day.endpoints[u.endpoint] = (day.endpoints[u.endpoint] ?? 0) + u.tokens;
    for (const [l, t] of Object.entries(u.languages)) day.languages[l] = (day.languages[l] ?? 0) + t;
    this.usage.set(key, day);
    for (const e of u.earnings) {
      const k = `${e.publisherId}_${u.date.replaceAll('-', '')}`;
      const cur = this.earnings.get(k) ?? { tokens: 0, grossMicros: 0, shareMicros: 0 };
      this.earnings.set(k, { tokens: cur.tokens + e.tokens, grossMicros: cur.grossMicros + e.grossMicros, shareMicros: cur.shareMicros + e.shareMicros });
    }
    day.publishers ??= {};
    for (const d of u.documents) {
      const p = (day.publishers[d.publisherId] ??= { tokens: 0, spendMicros: 0 });
      p.tokens += d.tokens;
      p.spendMicros += d.grossMicros;
      const k = `${d.documentId}_${u.month.replace('-', '')}`;
      const du = this.documentUsage.get(k) ?? { documentId: d.documentId, publisherId: d.publisherId, month: u.month, title: d.title, language: d.language, uses: 0, tokens: 0, shareMicros: 0 };
      du.uses += 1;
      du.tokens += d.tokens;
      du.shareMicros += d.shareMicros;
      this.documentUsage.set(k, du);
      const list = this.recentUses.get(d.publisherId) ?? [];
      list.unshift({ ts: u.ts, title: d.title, buyer: u.buyerName, endpoint: u.endpoint, tokens: d.tokens, shareMicros: d.shareMicros });
      this.recentUses.set(d.publisherId, list.slice(0, 20));
    }
    const b = this.buyers.get(u.buyerId);
    if (b) {
      b.usedTokensThisMonth = (b.usageMonth === u.month ? b.usedTokensThisMonth : 0) + u.tokens;
      b.usageMonth = u.month;
    }
  }
  async getBuyerUsage(buyerId: string, from: string, to: string) {
    return [...this.usage.values()]
      .filter((d) => d.buyerId === buyerId && d.date >= from && d.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(({ buyerId: _, ...d }) => d);
  }
  async listChunkIds(documentId: string) {
    return [...this.chunks.values()].filter((c) => c.documentId === documentId).map((c) => c.id);
  }
  async updateChunks(ids: string[], patch: Partial<Chunk>) {
    for (const id of ids) {
      const c = this.chunks.get(id);
      if (c) this.chunks.set(id, { ...c, ...patch });
    }
  }
  async listDocumentIds(publisherId: string) {
    return [...this.documents.values()].filter((d) => d.publisherId === publisherId).map((d) => d.id);
  }
}

export class MemoryBlobs implements Blobs {
  objects = new Map<string, Record<string, unknown>>();
  async readJson(uri: string) {
    const o = this.objects.get(uri);
    if (!o) throw new Error(`no object at ${uri}`);
    return o;
  }
}

export class MemoryLedger implements Ledger {
  rows: LedgerRow[] = [];
  fail = false;
  async publish(rows: LedgerRow[]) {
    if (this.fail) throw new Error('pubsub unavailable');
    this.rows.push(...rows);
  }
}

/** Bag-of-words hashing embedder: texts sharing words get similar vectors. Tests and local runs only. */
export class HashEmbedder implements Embedder {
  constructor(private dims = 768) {}
  vector(text: string): number[] {
    const v = new Array(this.dims).fill(0);
    for (const w of text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) {
      let h = 2166136261;
      for (const ch of w) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
      v[Math.abs(h) % this.dims] += 1;
    }
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
  }
  async embedQuery(text: string) {
    return this.vector(text);
  }
}

export class EchoAnswerer implements Answerer {
  fail = false;
  async answer(question: string, sources: AnswerSource[], language: string) {
    if (this.fail) throw new Error('model unavailable');
    return `(${language}) ${sources.map((s) => `${s.title} [${s.n}]`).join('; ')}`;
  }
}
