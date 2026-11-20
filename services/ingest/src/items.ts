// One item (a web page or an uploaded file) -> raw file + document stub + content.raw.
//
// Whether to send an item to the worker is decided by comparing its content
// hash with the document's current and pending hashes, NOT by whether the raw
// file already exists. That way an edit that is later reverted (A -> B -> A)
// is still sent, even though A's raw file is already stored.

import {
  contentHashFor,
  docIdFor,
  identityKeyFor,
  type IdentityKey,
  type RawReason,
  type Source,
} from '@fairsource/shared';
import type { Deps } from './deps.js';
import { canonicalFrom, mainText, titleFrom } from './html.js';
import { FetchError } from './http.js';

export type Mode = 'scheduled' | 'backfill' | 'manual';
export type ItemOutcome = 'new' | 'changed' | 'restored' | 'unchanged' | 'skipped' | 'failed';

export const QUEUED: ReadonlySet<ItemOutcome> = new Set(['new', 'changed', 'restored']);

export interface WebItem {
  url: string;
  guid?: string;
  title?: string;
  modifiedAt?: Date;
}

export interface Candidate {
  key: IdentityKey;
  contentHash: string;
  bytes: Uint8Array;
  contentType: string;
  sourceUrl: string | null;
  canonicalUrl: string | null;
  guid: string | null;
  title: string;
  modifiedAt?: Date;
}

const EXT: Record<string, string> = {
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'text/plain': 'txt',
};
export const extFor = (contentType: string) => EXT[contentType] ?? 'bin';

export function rawPath(publisherId: string, at: Date, hash: string, ext: string): string {
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${publisherId}/${at.getUTCFullYear()}/${mm}/${hash}.${ext}`;
}

function reasonFor(mode: Mode, outcome: ItemOutcome): RawReason {
  if (mode === 'backfill') return 'backfill';
  if (mode === 'manual') return 'manual_sync';
  return outcome === 'new' ? 'new' : 'changed';
}

/** Short article text (JavaScript-rendered pages) is not a reliable fingerprint; hash the bytes instead. */
const MIN_TEXT_FOR_HASH = 40;

const PAGE_ACCEPT = 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5';

export async function processWebItem(deps: Deps, source: Source, item: WebItem, mode: Mode): Promise<ItemOutcome> {
  const { fetcher, robots, log } = deps;
  if (!(await robots.allowed(item.url))) {
    log({ event: 'robots_skip', sourceId: source.id, url: item.url });
    return 'skipped';
  }

  let res;
  try {
    res = await fetcher.get(item.url, { accept: PAGE_ACCEPT });
  } catch (e) {
    if (!(e instanceof FetchError)) throw e;
    log({ severity: 'WARNING', event: 'fetch_failed', sourceId: source.id, url: item.url, kind: e.kind, error: e.message });
    return 'failed';
  }
  if (res.status < 200 || res.status >= 300) {
    log({ severity: 'WARNING', event: 'fetch_status', sourceId: source.id, url: item.url, status: res.status });
    return 'failed';
  }

  const contentType = res.contentType || 'text/html';
  const isHtml = contentType.includes('html');
  const html = isHtml ? res.text() : null;
  const text = html ? mainText(html) : '';
  const contentHash = contentHashFor(text.length >= MIN_TEXT_FOR_HASH ? text : Buffer.from(res.bytes));
  const canonical = html ? canonicalFrom(html, res.url) : null;
  const key = identityKeyFor({ kind: 'web', url: canonical ?? res.url, guid: item.guid, sourceId: source.id });

  return commit(
    deps,
    source,
    {
      key,
      contentHash,
      bytes: res.bytes,
      contentType,
      sourceUrl: item.url,
      canonicalUrl: key.startsWith('url:') ? key.slice(4) : null,
      guid: item.guid ?? null,
      title: item.title ?? (html ? titleFrom(html) : undefined) ?? item.url,
      modifiedAt: item.modifiedAt,
    },
    mode,
  );
}

export async function commit(deps: Deps, source: Source, c: Candidate, mode: Mode): Promise<ItemOutcome> {
  const { store, blobs, bus, now } = deps;
  const t = now();
  const docId = docIdFor(c.key);
  const existing = await store.getDocument(docId);
  const live = existing !== null && existing.status !== 'withdrawn';

  if (live && (existing.contentHash === c.contentHash || existing.pendingContentHash === c.contentHash)) {
    await store.touchDocument(docId, source.id, t, c.modifiedAt);
    return 'unchanged';
  }

  const path = rawPath(source.publisherId, t, c.contentHash, extFor(c.contentType));
  await blobs.putIfAbsent(path, c.bytes, c.contentType);

  const outcome: ItemOutcome = !existing ? 'new' : existing.status === 'withdrawn' ? 'restored' : 'changed';

  if (!existing) {
    await store.createDocument({
      id: docId,
      identityKey: c.key,
      canonicalUrl: c.canonicalUrl,
      sourceUrl: c.sourceUrl,
      guid: c.guid,
      publisherId: source.publisherId,
      sourceId: source.id,
      sourceIds: [source.id],
      version: 0,
      contentHash: '',
      pendingContentHash: null,
      title: c.title,
      sourceModifiedAt: c.modifiedAt ?? null,
      optOut: false,
      servable: false,
      status: 'queued',
      firstSeenAt: t,
      lastSeenAt: t,
      lastCheckedAt: null,
      lastHttpStatus: null,
      withdrawnAt: null,
      withdrawnReason: null,
    });
    await store.adjustItemCount(source.id, 1);
  } else if (outcome === 'restored') {
    // Its chunks were deleted on withdrawal, so it is processed again from scratch.
    await store.updateDocument(docId, { status: 'queued', withdrawnAt: null, withdrawnReason: null, cleanedAt: null });
    await store.adjustItemCount(source.id, 1);
  }
  // An edited document keeps serving its current version until the worker swaps it.

  await bus.publishRaw({
    schemaVersion: 2,
    docId,
    identityKey: c.key,
    contentHash: c.contentHash,
    publisherId: source.publisherId,
    sourceId: source.id,
    rawUri: blobs.uri(path),
    mimeType: c.contentType,
    sourceUrl: c.sourceUrl,
    sourceModifiedAt: c.modifiedAt?.toISOString() ?? null,
    reason: reasonFor(mode, outcome),
    fetchedAt: t.toISOString(),
  });

  // Only after the message is out: if publishing failed, the next run sends it again.
  await store.updateDocument(docId, { pendingContentHash: c.contentHash });
  await store.touchDocument(docId, source.id, t, c.modifiedAt);
  return outcome;
}
