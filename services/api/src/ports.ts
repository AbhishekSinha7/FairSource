// What the API needs from Firestore, Cloud Storage, Pub/Sub and Gemini.
// gcp.ts implements these for production; memory.ts for tests and local runs.

import type { Buyer, Chunk, DocumentRecord, Licence, Publisher } from '@fairsource/shared';

export type Scope = 'search' | 'answer' | 'documents';

export interface ApiKeyRecord {
  prefix: string;
  buyerId: string;
  name: string;
  hash: string; // sha256 hex of the full key
  scopes: Scope[];
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export type BuyerRecord = Pick<Buyer, 'id' | 'name' | 'country' | 'status' | 'monthlyQuotaTokens' | 'usedTokensThisMonth'> & {
  /** yyyy-mm that usedTokensThisMonth belongs to. */
  usageMonth?: string;
};

/** A chunk as returned by vector search: no embedding, plus cosine distance. */
export type ChunkHit = Omit<Chunk, 'embedding'> & { distance: number };

export type DocView = Pick<
  DocumentRecord,
  | 'id'
  | 'publisherId'
  | 'title'
  | 'sourceUrl'
  | 'canonicalUrl'
  | 'publishedAt'
  | 'language'
  | 'version'
  | 'status'
  | 'optOut'
  | 'duplicateOf'
  | 'needsReview'
  | 'safety'
  | 'tokenCount'
  | 'cleanUri'
  | 'summary'
  | 'author'
  | 'contentType'
>;

export type PublisherView = Pick<Publisher, 'id' | 'name' | 'revenueSharePct'>;

/** One row of ledger.usage_events (snake_case: the BigQuery subscription maps fields to columns). */
export interface LedgerRow {
  event_id: string;
  ts: string;
  buyer_id: string;
  api_key_prefix: string;
  endpoint: Endpoint;
  publisher_id: string;
  document_id: string;
  document_version: number;
  chunk_ids: string[];
  licence_id: string;
  licence_version: number;
  tokens_served: number;
  amount_micros: number;
  request_id: string;
}

export type Endpoint = 'search' | 'answer' | 'document' | 'mcp';

/** One served document, for the publisher's "Recent uses" and "Top articles". */
export interface DocumentUse {
  eventId: string;
  documentId: string;
  publisherId: string;
  title: string;
  language: string;
  tokens: number;
  grossMicros: number;
  shareMicros: number;
}

export interface UsageCounters {
  buyerId: string;
  buyerName: string;
  ts: Date;
  documents: DocumentUse[];
  date: string; // yyyy-mm-dd in the reporting time zone
  month: string; // yyyy-mm
  endpoint: Endpoint;
  tokens: number;
  amountMicros: number;
  languages: Record<string, number>;
  earnings: Array<{ publisherId: string; tokens: number; grossMicros: number; shareMicros: number }>;
}

export interface DayUsage {
  date: string;
  tokens: number;
  spendMicros: number;
  requests: number;
  endpoints: Record<string, number>;
  languages: Record<string, number>;
  /** Per publisher: tokens and spend, for the buyer's "Publishers you used". */
  publishers?: Record<string, { tokens: number; spendMicros: number }>;
}

export interface Store {
  getApiKey(prefix: string): Promise<ApiKeyRecord | null>;
  touchApiKey(prefix: string, at: Date): Promise<void>;
  getBuyer(id: string): Promise<BuyerRecord | null>;
  /** Pre-filtered on servable == true and optOut == false. */
  nearestChunks(vector: number[], limit: number): Promise<ChunkHit[]>;
  getDocuments(ids: string[]): Promise<Map<string, DocView>>;
  /** The highest-version active licence of each publisher. */
  activeLicences(publisherIds: string[]): Promise<Map<string, Licence>>;
  getPublishers(ids: string[]): Promise<Map<string, PublisherView>>;
  /** Live counters for the dashboards (the ledger stays the source of truth for money). */
  recordUsage(u: UsageCounters): Promise<void>;
  getBuyerUsage(buyerId: string, from: string, to: string): Promise<DayUsage[]>;
  listChunkIds(documentId: string): Promise<string[]>;
  updateChunks(ids: string[], patch: Partial<Chunk>): Promise<void>;
  listDocumentIds(publisherId: string): Promise<string[]>;
}

export interface Blobs {
  readJson(uri: string): Promise<Record<string, unknown>>;
}

export interface Ledger {
  /** Must succeed before a response is sent: nothing is served unmetered. */
  publish(rows: LedgerRow[]): Promise<void>;
}

export interface Embedder {
  embedQuery(text: string): Promise<number[]>;
}

export interface AnswerSource {
  n: number;
  title: string;
  publisher: string;
  text: string;
}

export interface Answerer {
  answer(question: string, sources: AnswerSource[], language: string): Promise<string>;
}
