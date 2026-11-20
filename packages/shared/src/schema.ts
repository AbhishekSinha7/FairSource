// FairSource: shared data model (schema version 2)
//
// The single source of truth for Firestore documents and Pub/Sub messages.
// The Python worker mirrors this file in services/worker/src/worker/models.py;
// change both together.
//
// What changed from v1 (Technical Implementation doc, 18 Nov):
//   - documents are keyed by a stable ID from the post's canonical URL, not by
//     contentHash. contentHash and version are fields; an edit bumps version.
//   - chunk IDs include the document version, so ledger rows always point at
//     the exact text that was served.
//   - documents carry sync fields (lastSeenAt, lastCheckedAt, withdrawnAt).
//   - sources carry backfill progress and HTTP cache validators.
//   - content.raw v2 carries docId + contentHash + reason.
//   - usage_events gains document_version (see infra/ledger.sql).
//
// Rule: only the ingest service mints document IDs (docIdFor). The worker and
// api read docId from messages and documents; they never recompute it.

import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 2;

/** Firestore Timestamps are converted to Date by our converters. */
export type Ts = Date;

export type LanguageCode = string; // ISO 639-1: mr, hi, en
export type ScriptCode = string; // ISO 15924: Deva, Latn
export type Territory = 'IN' | 'GLOBAL';
export type Use = 'rag' | 'training';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Query parameters that never change which article a URL points at. */
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|amp|output)$/i;

/**
 * Normalises a URL so the same article always gives the same key.
 * Used only to build the identity key; we still fetch the original URL.
 *
 *   http://WWW.Example.in/article/1/?utm_source=x#top  ->  https://example.in/article/1
 *
 * Ingest should first replace the item URL with the page's
 * <link rel="canonical"> when that points at the same host.
 */
export function canonicalizeUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.protocol = 'https:'; // URL already drops default ports (80, 443); other ports are kept
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  u.username = '';
  u.password = '';
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = new URLSearchParams(kept).toString();
  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  u.pathname = path;
  return u.toString();
}

/**
 * The identity key decides "is this the same post?".
 * Web content uses the canonical URL whenever we have one, so the same post
 * reached through RSS and through the sitemap becomes ONE document.
 * The RSS GUID is used only for items with no usable link.
 * An upload has no URL; each distinct file is its own document.
 */
export type IdentityKey = `url:${string}` | `guid:${string}` | `upload:${string}`;

export function identityKeyFor(
  input:
    | { kind: 'web'; url?: string | null; guid?: string | null; sourceId: string }
    | { kind: 'upload'; contentHash: string },
): IdentityKey {
  if (input.kind === 'upload') return `upload:${input.contentHash}`;
  if (input.url) return `url:${canonicalizeUrl(input.url)}`;
  if (input.guid) return `guid:${input.sourceId}:${input.guid}`; // GUIDs are only unique per feed
  throw new Error('web item has neither url nor guid');
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** Document ID: first 32 hex chars (128 bits) of sha256(identityKey). */
export function docIdFor(key: IdentityKey): string {
  return sha256(key).slice(0, 32);
}

/** Chunk ID: `{docId}_v{version}_{n}`. Old versions' IDs are never reused. */
export function chunkIdFor(docId: string, version: number, n: number): string {
  return `${docId}_v${version}_${n}`;
}

/** sha256 of the normalised article body (HTML) or of the file bytes (upload). */
export function contentHashFor(normalisedBodyOrBytes: string | Buffer): string {
  return sha256(normalisedBodyOrBytes);
}

// ---------------------------------------------------------------------------
// Firestore collections
// ---------------------------------------------------------------------------

/** publishers/{pub_*} */
export interface Publisher {
  id: string;
  name: string;
  country: string; // ISO 3166-1 alpha-2
  languages: LanguageCode[];
  ownerUid: string;
  revenueSharePct: number; // default 75
  payout: { provider: 'stripe' | 'razorpay'; accountRef: string } | null;
  status: 'onboarding' | 'active' | 'suspended';
  createdAt: Ts;
}

export type SourceType = 'rss' | 'sitemap' | 'upload' | 'cms';

/** sources/{src_*} */
export interface Source {
  id: string;
  publisherId: string;
  type: SourceType;
  name: string; // "Pune city news"
  url: string | null; // null for upload sources
  /** How we found this feed when the publisher pasted only their site URL. */
  discoveredFrom: 'manual' | 'link_rel' | 'well_known_path' | 'robots_txt' | null;
  consentAt: Ts;
  scheduleMins: number; // 30
  status: 'active' | 'paused' | 'error';
  lastError: string | null;

  /** Last scheduled or manual run, whether or not it found anything. */
  lastFetchedAt: Ts | null;
  /** Last full read of the sitemap, used by the deletion sweep. */
  lastFullSyncAt: Ts | null;
  /** HTTP cache validators, sent back as If-None-Match / If-Modified-Since. */
  etag: string | null;
  lastModifiedHeader: string | null;

  /**
   * Runs once when the source is connected: reads the full sitemap, or pages
   * back through the feed / WordPress ?paged=N, so existing posts are imported
   * and not only the newest items in the feed.
   */
  backfill: {
    status: 'pending' | 'running' | 'done' | 'failed';
    discovered: number; // URLs found
    queued: number; // content.raw messages sent
    cursor: string | null; // next page or sitemap index position, for resuming
    startedAt: Ts | null;
    finishedAt: Ts | null;
  };

  /** Set by the "Sync now" button; ingest runs the source at once and clears it. */
  syncRequestedAt: Ts | null;
  /** Ingest holds this while a run or sweep is in progress, so two runs never overlap. */
  leaseUntil: Ts | null;

  itemCount: number; // documents with status != withdrawn
}

/**
 * A new source as the dashboard creates it. Feed sources start with a pending
 * backfill, so ingest imports existing posts on its next run.
 */
export function newSource(init: {
  id: string;
  publisherId: string;
  type: SourceType;
  name: string;
  url: string | null;
  discoveredFrom?: Source['discoveredFrom'];
  consentAt: Ts;
  scheduleMins?: number;
}): Source {
  const isFeed = init.type === 'rss' || init.type === 'sitemap';
  return {
    id: init.id,
    publisherId: init.publisherId,
    type: init.type,
    name: init.name,
    url: init.url,
    discoveredFrom: init.discoveredFrom ?? (init.url ? 'manual' : null),
    consentAt: init.consentAt,
    scheduleMins: init.scheduleMins ?? 30,
    status: 'active',
    lastError: null,
    lastFetchedAt: null,
    lastFullSyncAt: null,
    etag: null,
    lastModifiedHeader: null,
    backfill: { status: isFeed ? 'pending' : 'done', discovered: 0, queued: 0, cursor: null, startedAt: null, finishedAt: null },
    syncRequestedAt: null,
    leaseUntil: null,
    itemCount: 0,
  };
}

/** The tag buyers see on every result, e.g. "rag/IN+GLOBAL/v3". */
export function licenceTag(l: Pick<Licence, 'uses' | 'territories' | 'version'>): string {
  const uses = (['rag', 'training'] as const).filter((u) => l.uses.includes(u)).join('+') || 'none';
  const terr = (['IN', 'GLOBAL'] as const).filter((t) => l.territories.includes(t)).join('+') || 'none';
  return `${uses}/${terr}/v${l.version}`;
}

/** licences/{lic_*}. Every save creates a new doc with version + 1. */
export interface Licence {
  id: string;
  publisherId: string;
  uses: Use[];
  territories: Territory[];
  pricePer1kTokensMicros: number; // USD micros; $0.002 = 2000
  active: boolean;
  version: number;
  createdAt: Ts;
}

export type DocumentStatus =
  | 'queued' // known, waiting for the worker
  | 'processing'
  | 'done'
  | 'failed'
  | 'withdrawn'; // gone from the publisher's site, or removed by the publisher

export type WithdrawnReason =
  | 'http_404'
  | 'http_410'
  | 'publisher_removed' // deleted from the dashboard
  | 'source_disconnected';

export type SafetyLabel = 'ok' | 'adult' | 'hate' | 'pii_heavy';

/** documents/{docId}. docId = docIdFor(identityKey). */
export interface DocumentRecord {
  id: string;
  identityKey: IdentityKey;
  canonicalUrl: string | null;
  sourceUrl: string | null; // URL as the source gave it, used for fetching and attribution
  guid: string | null;
  publisherId: string;
  sourceId: string; // first source that found it
  sourceIds: string[]; // every source that lists it (RSS + sitemap)

  // Versioning. An edit on the publisher's site gives a new contentHash, so
  // version + 1, and the worker replaces the chunks in one batch.
  version: number; // starts at 1
  contentHash: string;
  /** contentHash of the version currently being processed; equals contentHash once done. */
  pendingContentHash: string | null;

  // Metadata from Gemini clean-and-structure (prompts/clean.v1.json)
  title: string;
  author: string | null;
  publishedAt: Ts | null;
  /** Publisher-side modification time (sitemap lastmod, Atom <updated>, WP modified_gmt). */
  sourceModifiedAt: Ts | null;
  language: LanguageCode;
  script: ScriptCode;
  topics: string[];
  summary: string | null;
  contentType: 'news' | 'opinion' | 'feature' | 'book' | 'other';
  qualityScore: number;
  chunkCount: number;
  tokenCount: number;

  // Duplicate check: only against documents with a DIFFERENT id
  // (the same story republished at another URL). Same URL = new version, not a duplicate.
  simhash: string; // 64-bit, hex
  band0: number;
  band1: number;
  band2: number;
  band3: number;
  duplicateOf: string | null;

  // Serving
  needsReview: boolean; // language checks disagree
  safety: SafetyLabel;
  optOut: boolean; // publisher toggle on the Content page
  /** Computed: status=done && !duplicateOf && !needsReview && safety=ok && !optOut. */
  servable: boolean;
  status: DocumentStatus;
  licenceId: string;

  // Storage (deleted by the cleanup job after withdrawal; see below)
  rawUri: string | null;
  cleanUri: string | null;

  // Sync
  firstSeenAt: Ts;
  /** Last time the item appeared in its feed or sitemap. */
  lastSeenAt: Ts;
  /** Last direct HTTP check of sourceUrl (deletion sweep). */
  lastCheckedAt: Ts | null;
  lastHttpStatus: number | null;
  processedAt: Ts | null;
  withdrawnAt: Ts | null;
  withdrawnReason: WithdrawnReason | null;

  // Worker bookkeeping
  /** sha256 of the cleaned body. If an edit leaves it unchanged, nothing is re-embedded. */
  cleanHash?: string | null;
  /** fetchedAt of the content.raw message last processed; older messages are ignored. */
  processedFetchedAt?: Ts | null;
  /** Why the last processing attempt failed; cleared on success. */
  processingError?: string | null;
  /** Set when a withdrawn document's chunks and files have been deleted; null while waiting. */
  cleanedAt?: Ts | null;
}

/**
 * What ingest writes when it first sees a post, before the worker has run:
 * version 0, contentHash '' and status 'queued'. The worker fills in every
 * other field when it processes the first version.
 *
 * On an edit, ingest leaves the document as it is (still served at its current
 * version) and only sets pendingContentHash; the worker swaps versions atomically.
 */
export type DocumentStub = Pick<
  DocumentRecord,
  | 'id'
  | 'identityKey'
  | 'canonicalUrl'
  | 'sourceUrl'
  | 'guid'
  | 'publisherId'
  | 'sourceId'
  | 'sourceIds'
  | 'version'
  | 'contentHash'
  | 'pendingContentHash'
  | 'title'
  | 'sourceModifiedAt'
  | 'optOut'
  | 'servable'
  | 'status'
  | 'firstSeenAt'
  | 'lastSeenAt'
  | 'lastCheckedAt'
  | 'lastHttpStatus'
  | 'withdrawnAt'
  | 'withdrawnReason'
> &
  Partial<DocumentRecord>;

/**
 * documents/{docId}/versions/{version}: one row per processed version.
 * Keeps what was served, and when, after chunks are replaced.
 * After withdrawal, keep only hashes and counts; delete rawUri and cleanUri.
 */
export interface DocumentVersion {
  version: number;
  contentHash: string;
  rawUri: string | null;
  cleanUri: string | null;
  chunkCount: number;
  tokenCount: number;
  licenceId: string;
  processedAt: Ts;
  supersededAt: Ts | null;
}

/** chunks/{docId}_v{version}_{n}. Only the current version's chunks exist. */
export interface Chunk {
  id: string;
  documentId: string;
  documentVersion: number;
  n: number; // 0-based position in the document
  publisherId: string;
  text: string; // first line is the title
  tokenCount: number;
  embedding: number[]; // Firestore vector, 768 dims, normalised
  language: LanguageCode;
  // Rights, copied from document + active licence and re-stamped on change
  servable: boolean;
  optOut: boolean;
  uses: Use[];
  territories: Territory[];
  licenceId: string;
  licenceVersion: number;
}

/** buyers/{buy_*} */
export interface Buyer {
  id: string;
  name: string;
  ownerUid: string;
  country: string;
  plan: string;
  monthlyQuotaTokens: number;
  usedTokensThisMonth: number;
  status: 'active' | 'suspended';
}

/** apiKeys/{prefix}. Key format: fs_<8-char prefix>_<secret>. Only the hash is stored. */
export interface ApiKey {
  prefix: string;
  buyerId: string;
  name: string;
  hash: string; // sha256 of the full key
  scopes: Array<'search' | 'answer' | 'documents'>;
  createdAt: Ts;
  lastUsedAt: Ts | null;
  revokedAt: Ts | null;
}

/** earnings/{pubId}_{yyyymmdd}: live counter for the dashboard only. Payouts use the ledger. */
export interface EarningsDay {
  publisherId: string;
  date: string; // yyyy-mm-dd
  tokensServed: number;
  grossMicros: number;
  publisherShareMicros: number;
}

// ---------------------------------------------------------------------------
// Pub/Sub messages
// ---------------------------------------------------------------------------

export type RawReason = 'new' | 'changed' | 'backfill' | 'manual_sync';

/**
 * content.raw: ingest -> worker. One message per new or changed item.
 * Ingest still writes raw files to gs://…-raw/{publisherId}/{yyyy}/{mm}/{contentHash}.{ext}
 * with ifGenerationMatch=0, so an unchanged item is a no-op and sends nothing.
 *
 * Worker idempotency: if documents/{docId}.contentHash == contentHash and
 * status == 'done', ack and stop. Otherwise process as version + 1.
 */
export interface ContentRawMessage {
  schemaVersion: 2;
  docId: string;
  identityKey: IdentityKey;
  contentHash: string;
  publisherId: string;
  sourceId: string;
  rawUri: string;
  mimeType: string;
  sourceUrl: string | null;
  sourceModifiedAt: string | null; // ISO 8601
  reason: RawReason;
  fetchedAt: string; // ISO 8601
}

/** content.processed: worker -> anyone listening (dashboard log, Processing panel). */
export interface ContentProcessedMessage {
  schemaVersion: 2;
  docId: string;
  version: number;
  contentHash: string;
  publisherId: string;
  status: 'done' | 'failed';
  servable: boolean;
  chunkCount: number;
  replacedChunkCount: number; // chunks of the previous version that were deleted (0 for new)
  processedAt: string;
}

/**
 * Withdrawal (no new topic needed):
 *  1. ingest sets status='withdrawn', servable=false, withdrawnAt, withdrawnReason.
 *  2. The existing Eventarc re-stamp function sees the documents update and sets
 *     servable=false on its chunks, so they leave search within seconds.
 *  3. A cleanup job deletes the chunks, rawUri and cleanUri, and nulls them on the
 *     version rows. We no longer hold the text of a post the publisher removed.
 *  4. The document row (title, ids, hashes) and every ledger row stay, so past
 *     earnings and statements remain correct.
 */
