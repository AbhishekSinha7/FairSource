// Endpoint logic, independent of HTTP: search, answer, document, usage, restamp.

import { randomUUID } from 'node:crypto';
import { licenceTag, type Licence, type Use } from '@fairsource/shared';
import type { Caller } from './auth.js';
import type { ApiConfig } from './config.js';
import { localDate, meter, type Served } from './meter.js';
import type { Answerer, Blobs, ChunkHit, DocView, Embedder, Endpoint, Ledger, PublisherView, Store } from './ports.js';
import { documentServable, isLiveServable, licenceAllows } from './rights.js';

export interface Deps {
  cfg: ApiConfig;
  store: Store;
  blobs: Blobs;
  ledger: Ledger;
  embedder: Embedder;
  answerer: Answerer;
  now: () => Date;
  log: (e: Record<string, unknown>) => void;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Publishers' active licences, cached briefly so licence changes apply within seconds. */
export class LicenceCache {
  private cache = new Map<string, { at: number; lic: Licence | undefined }>();
  constructor(
    private store: Store,
    private ttlMs: number,
    private now: () => Date,
  ) {}

  async get(publisherIds: string[]): Promise<Map<string, Licence>> {
    const t = this.now().getTime();
    const missing = [...new Set(publisherIds)].filter((p) => {
      const c = this.cache.get(p);
      return !c || t - c.at > this.ttlMs;
    });
    if (missing.length) {
      const fresh = await this.store.activeLicences(missing);
      for (const p of missing) this.cache.set(p, { at: t, lic: fresh.get(p) });
    }
    const out = new Map<string, Licence>();
    for (const p of publisherIds) {
      const l = this.cache.get(p)?.lic;
      if (l) out.set(p, l);
    }
    return out;
  }
}

export interface Hit {
  chunk: ChunkHit;
  doc: DocView;
  licence: Licence;
  publisher: PublisherView | undefined;
}

export function attribution(doc: DocView, licence: Licence, publisher: PublisherView | undefined) {
  const name = publisher?.name ?? 'the publisher';
  return {
    publisher: name,
    title: doc.title,
    url: doc.sourceUrl ?? doc.canonicalUrl ?? null,
    publishedAt: doc.publishedAt ? new Date(doc.publishedAt).toISOString().slice(0, 10) : null,
    licence: licenceTag(licence),
    text: `Source: ${name}, licensed via FairSource`,
  };
}

/** Embed -> nearest 50 (pre-filtered) -> language filter -> live rights check -> top `limit`. */
export async function retrieve(d: Deps, licences: LicenceCache, caller: Caller, query: string, use: Use, limit: number, languages?: string[]): Promise<Hit[]> {
  const vector = await d.embedder.embedQuery(query);
  let cands = (await d.store.nearestChunks(vector, d.cfg.candidates)).filter((c) => 1 - c.distance >= d.cfg.minScore);
  if (languages?.length) cands = cands.filter((c) => languages.includes(c.language));
  if (!cands.length) return [];

  const docs = await d.store.getDocuments([...new Set(cands.map((c) => c.documentId))]);
  const lics = await licences.get([...new Set(cands.map((c) => c.publisherId))]);
  const ok = cands
    .filter((c) => isLiveServable(c, docs.get(c.documentId), lics.get(c.publisherId), caller.buyer, use))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
  const pubs = await d.store.getPublishers([...new Set(ok.map((c) => c.publisherId))]);
  return ok.map((c) => ({ chunk: c, doc: docs.get(c.documentId)!, licence: lics.get(c.publisherId)!, publisher: pubs.get(c.publisherId) }));
}

/** Write the ledger rows (must succeed), then the live counters (best effort). */
async function charge(d: Deps, caller: Caller, endpoint: Endpoint, requestId: string, served: Served[], licences: Map<string, Licence>, publishers: Map<string, PublisherView>) {
  const { rows, counters } = meter(served, licences, publishers, {
    buyerId: caller.buyer.id,
    buyerName: caller.buyer.name,
    keyPrefix: caller.key.prefix,
    endpoint,
    requestId,
    now: d.now(),
    timeZone: d.cfg.timeZone,
  });
  if (!rows.length) return counters;
  try {
    await d.ledger.publish(rows);
  } catch (e) {
    d.log({ severity: 'ERROR', event: 'ledger_publish_failed', requestId, error: (e as Error).message });
    throw new ApiError(503, 'upstream', 'Usage could not be recorded, so nothing was served. Please retry.');
  }
  d.store.recordUsage(counters).catch((e) => d.log({ severity: 'WARNING', event: 'counter_update_failed', requestId, error: (e as Error).message }));
  return counters;
}

const servedFrom = (hits: Hit[]): Served[] =>
  hits.map((h) => ({
    documentId: h.doc.id,
    title: h.doc.title,
    documentVersion: h.doc.version,
    publisherId: h.chunk.publisherId,
    language: h.chunk.language,
    chunkIds: [h.chunk.id],
    tokens: h.chunk.tokenCount,
  }));

const maps = (hits: Hit[]) => ({
  lics: new Map(hits.map((h) => [h.chunk.publisherId, h.licence])),
  pubs: new Map(hits.filter((h) => h.publisher).map((h) => [h.chunk.publisherId, h.publisher!])),
});

export async function search(
  d: Deps,
  lc: LicenceCache,
  caller: Caller,
  req: { query: string; languages?: string[]; limit: number; use: Use },
  endpoint: Endpoint,
) {
  const requestId = `req_${randomUUID()}`;
  const hits = await retrieve(d, lc, caller, req.query, req.use, req.limit, req.languages);
  const { lics, pubs } = maps(hits);
  const counters = await charge(d, caller, endpoint, requestId, servedFrom(hits), lics, pubs);
  return {
    requestId,
    results: hits.map((h) => ({
      chunkId: h.chunk.id,
      documentId: h.doc.id,
      score: Math.round((1 - h.chunk.distance) * 1000) / 1000,
      language: h.chunk.language,
      text: h.chunk.text,
      attribution: attribution(h.doc, h.licence, h.publisher),
    })),
    usage: { tokensServed: counters.tokens, amountMicros: counters.amountMicros },
  };
}

const NO_ANSWER: Record<string, string> = {
  en: 'No licensed source in FairSource answers this question.',
  hi: 'FairSource के किसी भी लाइसेंस प्राप्त स्रोत में इस प्रश्न का उत्तर नहीं है।',
  mr: 'FairSource मधील कोणत्याही परवानाधारक स्रोतात या प्रश्नाचे उत्तर नाही.',
};

export async function answer(
  d: Deps,
  lc: LicenceCache,
  caller: Caller,
  req: { question: string; answerLanguage: string; maxSources: number; languages?: string[] },
  endpoint: Endpoint,
) {
  const requestId = `req_${randomUUID()}`;
  const hits = await retrieve(d, lc, caller, req.question, 'rag', req.maxSources, req.languages);
  if (!hits.length) {
    return { requestId, answer: NO_ANSWER[req.answerLanguage] ?? NO_ANSWER.en, citations: [], usage: { tokensServed: 0, amountMicros: 0 } };
  }
  const sources = hits.map((h, i) => ({ n: i + 1, title: h.doc.title, publisher: h.publisher?.name ?? '', text: h.chunk.text }));
  let text: string;
  try {
    text = await d.answerer.answer(req.question, sources, req.answerLanguage);
  } catch (e) {
    d.log({ severity: 'ERROR', event: 'answer_failed', requestId, error: (e as Error).message });
    throw new ApiError(503, 'upstream', 'The answer model is unavailable. Nothing was charged.');
  }
  // Every source given to the model is metered: its content grounded the answer.
  const { lics, pubs } = maps(hits);
  const counters = await charge(d, caller, endpoint, requestId, servedFrom(hits), lics, pubs);
  return {
    requestId,
    answer: text,
    citations: hits.map((h, i) => ({ n: i + 1, documentId: h.doc.id, cited: text.includes(`[${i + 1}]`), attribution: attribution(h.doc, h.licence, h.publisher) })),
    usage: { tokensServed: counters.tokens, amountMicros: counters.amountMicros },
  };
}

export async function getDocument(d: Deps, lc: LicenceCache, caller: Caller, id: string, use: Use) {
  const doc = (await d.store.getDocuments([id])).get(id);
  const lic = doc ? (await lc.get([doc.publisherId])).get(doc.publisherId) : undefined;
  // Never reveal whether a document exists but isn't licensed to this buyer.
  if (!doc || !documentServable(doc) || !licenceAllows(lic, caller.buyer, use) || caller.buyer.status !== 'active' || !doc.cleanUri) {
    throw new ApiError(404, 'not_found', 'No licensed document with that ID.');
  }
  const clean = await d.blobs.readJson(doc.cleanUri);
  const pubs = await d.store.getPublishers([doc.publisherId]);
  const requestId = `req_${randomUUID()}`;
  const served: Served[] = [{ documentId: doc.id, title: doc.title, documentVersion: doc.version, publisherId: doc.publisherId, language: doc.language, chunkIds: [], tokens: doc.tokenCount }];
  const counters = await charge(d, caller, 'document', requestId, served, new Map([[doc.publisherId, lic!]]), pubs);
  return {
    requestId,
    document: {
      id: doc.id,
      title: doc.title,
      author: doc.author ?? null,
      publishedAt: doc.publishedAt ? new Date(doc.publishedAt).toISOString() : null,
      language: doc.language,
      contentType: doc.contentType,
      summary: doc.summary ?? null,
      body: String(clean.body ?? ''),
      attribution: attribution(doc, lic!, pubs.get(doc.publisherId)),
    },
    usage: { tokensServed: counters.tokens, amountMicros: counters.amountMicros },
  };
}

export async function usage(d: Deps, caller: Caller, from?: string, to?: string) {
  const today = localDate(d.now(), d.cfg.timeZone);
  const start = from ?? `${today.slice(0, 7)}-01`;
  const end = to ?? today;
  const days = await d.store.getBuyerUsage(caller.buyer.id, start, end);
  const sum = (f: (x: (typeof days)[number]) => number) => days.reduce((n, x) => n + f(x), 0);
  const month = today.slice(0, 7);
  return {
    from: start,
    to: end,
    totals: { tokens: sum((x) => x.tokens), spendMicros: sum((x) => x.spendMicros), requests: sum((x) => x.requests) },
    quota: {
      monthlyTokens: caller.buyer.monthlyQuotaTokens,
      usedThisMonth: caller.buyer.usageMonth === month ? caller.buyer.usedTokensThisMonth : 0,
    },
    days,
    note: 'Live counters. Invoices are computed from the usage ledger.',
  };
}

/**
 * Re-stamp chunk rights from the document and licence as they are now. Search is
 * already correct without this (rights are re-checked live); re-stamping keeps
 * the vector pre-filter in step, e.g. so an article that is opted back in reappears.
 */
export async function restamp(d: Deps, target: { documentId?: string; publisherId?: string }) {
  const ids = target.documentId ? [target.documentId] : await d.store.listDocumentIds(target.publisherId!);
  let chunks = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const docs = await d.store.getDocuments(ids.slice(i, i + 100));
    const lics = await d.store.activeLicences([...new Set([...docs.values()].map((x) => x.publisherId))]);
    for (const doc of docs.values()) {
      const lic = lics.get(doc.publisherId);
      const chunkIds = await d.store.listChunkIds(doc.id);
      if (!chunkIds.length) continue;
      await d.store.updateChunks(chunkIds, {
        servable: documentServable(doc),
        optOut: doc.optOut,
        uses: lic?.uses ?? [],
        territories: lic?.territories ?? [],
        licenceId: lic?.id ?? '',
        licenceVersion: lic?.version ?? 0,
      });
      chunks += chunkIds.length;
    }
  }
  return { documents: ids.length, chunks };
}
