// Running a source: scheduled runs, "Sync now", and resumable backfill.

import { canonicalizeUrl, docIdFor, type Source } from '@fairsource/shared';
import type { Deps } from './deps.js';
import { NotAFeedError, parseFeed, wordpressNextPage, type FeedItem } from './feeds.js';
import type { FetchResult } from './http.js';
import { QUEUED, processWebItem, type ItemOutcome, type Mode, type WebItem } from './items.js';
import { parseSitemap, type Sitemap, type SitemapEntry } from './sitemap.js';

export type Counts = Record<ItemOutcome, number>;

export interface RunSummary {
  sourceId: string;
  result: 'ran' | 'busy' | 'not_found' | 'not_runnable' | 'error';
  mode?: Mode;
  counts?: Counts;
  notModified?: boolean;
  backfill?: Source['backfill'];
  error?: string;
}

const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5';
const SITEMAP_ACCEPT = 'application/xml, text/xml;q=0.9, */*;q=0.5';

const emptyCounts = (): Counts => ({ new: 0, changed: 0, restored: 0, unchanged: 0, skipped: 0, failed: 0 });

export function isDue(s: Source, now: Date): boolean {
  if (s.status === 'paused' || !s.url || (s.type !== 'rss' && s.type !== 'sitemap')) return false;
  if (s.backfill.status === 'pending' || s.backfill.status === 'running') return true;
  if (s.syncRequestedAt) return true;
  if (!s.lastFetchedAt) return true;
  return now.getTime() - s.lastFetchedAt.getTime() >= s.scheduleMins * 60_000;
}

export function modeFor(s: Source, requested?: Mode): Mode {
  if (s.backfill.status === 'pending' || s.backfill.status === 'running') return 'backfill';
  if (requested) return requested;
  return s.syncRequestedAt ? 'manual' : 'scheduled';
}

interface Ctx {
  deps: Deps;
  source: Source;
  mode: Mode;
  counts: Counts;
  /** Stop starting new items after this time (ms, deps.now() clock). */
  deadline: number;
}

const outOfTime = (ctx: Ctx) => ctx.deps.now().getTime() >= ctx.deadline;

function ensureOk(res: FetchResult, what: string) {
  if (res.status < 200 || res.status >= 300) throw new Error(`${what} ${res.url} returned HTTP ${res.status}`);
}

async function handle(ctx: Ctx, item: WebItem): Promise<ItemOutcome> {
  const outcome = await processWebItem(ctx.deps, ctx.source, item, ctx.mode);
  ctx.counts[outcome] += 1;
  return outcome;
}

const toWebItem = (it: FeedItem): WebItem => ({ url: it.url!, guid: it.guid, title: it.title, modifiedAt: it.updated ?? it.published });

export async function runSource(deps: Deps, sourceId: string, requested?: Mode, deadline?: number): Promise<RunSummary> {
  const { store, cfg, log } = deps;
  const start = deps.now();
  const source = await store.getSource(sourceId);
  if (!source) return { sourceId, result: 'not_found' };
  if (!source.url || (source.type !== 'rss' && source.type !== 'sitemap') || source.status === 'paused') return { sourceId, result: 'not_runnable' };
  if (!(await store.acquireLease(sourceId, start, new Date(start.getTime() + cfg.leaseMs)))) return { sourceId, result: 'busy' };

  const mode = modeFor(source, requested);
  const ctx: Ctx = { deps, source, mode, counts: emptyCounts(), deadline: Math.min(deadline ?? Infinity, start.getTime() + cfg.runBudgetMs) };

  try {
    if (mode === 'backfill' && source.backfill.status === 'pending') {
      source.backfill = { ...source.backfill, status: 'running', startedAt: start, discovered: 0, queued: 0, cursor: null };
      await store.updateSource(sourceId, { backfill: source.backfill });
    }
    if (!(await deps.robots.allowed(source.url))) throw new Error(`robots.txt does not allow fetching ${source.url}`);

    const out = source.type === 'rss' ? await runRss(ctx) : await runSitemap(ctx);
    await store.updateSource(sourceId, { lastFetchedAt: deps.now(), syncRequestedAt: null, status: 'active', lastError: null, ...out.patch });
    log({ event: 'source_run', sourceId, mode, counts: ctx.counts, notModified: out.notModified ?? false, backfill: out.patch.backfill?.status });
    return { sourceId, result: 'ran', mode, counts: ctx.counts, notModified: out.notModified, backfill: out.patch.backfill ?? source.backfill };
  } catch (e) {
    const message = (e as Error).message.slice(0, 500);
    await store.updateSource(sourceId, { lastFetchedAt: deps.now(), syncRequestedAt: null, status: 'error', lastError: message });
    log({ severity: 'ERROR', event: 'source_failed', sourceId, mode, error: message });
    return { sourceId, result: 'error', mode, counts: ctx.counts, error: message };
  } finally {
    await store.releaseLease(sourceId);
  }
}

interface RunOut {
  patch: Partial<Source>;
  notModified?: boolean;
}

// ------------------------------------------------------------------- RSS

async function runRss(ctx: Ctx): Promise<RunOut> {
  const { deps, source } = ctx;
  if (ctx.mode !== 'backfill') {
    const res = await deps.fetcher.get(source.url!, { accept: FEED_ACCEPT, etag: source.etag, lastModified: source.lastModifiedHeader });
    if (res.status === 304) return { patch: {}, notModified: true };
    ensureOk(res, 'feed');
    const feed = parseFeed(res.text(), res.url);
    // Every item in the current feed is re-hashed: that is how edits are found.
    for (const it of feed.items) {
      if (!it.url) continue;
      await handle(ctx, toWebItem(it));
      if (outOfTime(ctx)) break;
    }
    return { patch: { etag: res.etag, lastModifiedHeader: res.lastModified } };
  }

  // Backfill: page back through the feed (rel="next", else WordPress ?paged=N).
  let bf = { ...source.backfill };
  let pageUrl = bf.cursor ?? source.url!;
  const seen = new Set<string>();
  for (let page = 0; page < deps.cfg.maxFeedPages; page++) {
    const res = await deps.fetcher.get(pageUrl, { accept: FEED_ACCEPT });
    if (page > 0 && (res.status === 404 || res.status === 410)) break; // past the last page
    ensureOk(res, 'feed page');
    let items: FeedItem[];
    let next: string | undefined;
    try {
      const feed = parseFeed(res.text(), res.url);
      items = feed.items;
      next = feed.next;
    } catch (e) {
      if (page > 0 && e instanceof NotAFeedError) break;
      throw e;
    }
    const fresh = items.filter((i) => i.url && !seen.has(i.url));
    if (fresh.length === 0) break; // a site without paging returns the same page again
    bf.discovered += fresh.length;

    for (const it of fresh) {
      seen.add(it.url!);
      if (QUEUED.has(await handle(ctx, toWebItem(it)))) bf.queued += 1;
    }
    pageUrl = next ?? wordpressNextPage(res.url);
    bf = { ...bf, cursor: pageUrl };
    await deps.store.updateSource(source.id, { backfill: bf });
    if (outOfTime(ctx)) return { patch: { backfill: bf } };
  }
  return { patch: { backfill: { ...bf, status: 'done', cursor: null, finishedAt: deps.now() } } };
}

// --------------------------------------------------------------- Sitemap

/** Reads a sitemap and, for an index, its child sitemaps (two levels deep at most). */
export async function readSitemapUrls(deps: Deps, source: Source, top: Sitemap, since: Date | null): Promise<SitemapEntry[]> {
  const out = new Map<string, SitemapEntry>();
  const add = (entries: SitemapEntry[]) => {
    for (const e of entries) if (out.size < deps.cfg.maxSitemapUrls && !out.has(e.loc)) out.set(e.loc, e);
  };

  const walk = async (sm: Sitemap, depth: number) => {
    if (sm.kind === 'urlset') return add(sm.entries);
    if (depth >= 2) return;
    for (const child of sm.entries) {
      if (out.size >= deps.cfg.maxSitemapUrls) break;
      if (since && child.lastmod && child.lastmod <= since) continue; // unchanged since the last run
      if (!(await deps.robots.allowed(child.loc))) continue;
      try {
        const res = await deps.fetcher.get(child.loc, { accept: SITEMAP_ACCEPT });
        ensureOk(res, 'sitemap');
        await walk(parseSitemap(res.text()), depth + 1);
      } catch (e) {
        deps.log({ severity: 'WARNING', event: 'child_sitemap_failed', sourceId: source.id, url: child.loc, error: (e as Error).message });
      }
    }
  };
  await walk(top, 0);
  return [...out.values()];
}

async function needsFetch(deps: Deps, source: Source, e: SitemapEntry): Promise<boolean> {
  let id: string;
  try {
    id = docIdFor(`url:${canonicalizeUrl(e.loc)}`);
  } catch {
    return false;
  }
  const doc = (await deps.store.getDocument(id)) ?? (await deps.store.findBySourceUrl(source.publisherId, e.loc));
  if (!doc) return true;
  if (doc.status === 'withdrawn') return true;
  if (e.lastmod && (!doc.sourceModifiedAt || e.lastmod > doc.sourceModifiedAt)) return true;
  return false;
}

async function runSitemap(ctx: Ctx): Promise<RunOut> {
  const { deps, source, mode } = ctx;
  const conditional = mode === 'scheduled';
  const res = await deps.fetcher.get(source.url!, {
    accept: SITEMAP_ACCEPT,
    etag: conditional ? source.etag : null,
    lastModified: conditional ? source.lastModifiedHeader : null,
  });
  if (res.status === 304) return { patch: {}, notModified: true };
  ensureOk(res, 'sitemap');
  const top = parseSitemap(res.text());
  const since = mode === 'backfill' ? null : source.lastFetchedAt;
  const entries = await readSitemapUrls(deps, source, top, since);
  const cache = { etag: res.etag, lastModifiedHeader: res.lastModified };

  if (mode !== 'backfill') {
    // Newest first, so the time budget goes to fresh posts.
    entries.sort((a, b) => (b.lastmod?.getTime() ?? 0) - (a.lastmod?.getTime() ?? 0));
    for (const e of entries) {
      if (!(await needsFetch(deps, source, e))) continue;
      await handle(ctx, { url: e.loc, modifiedAt: e.lastmod });
      if (outOfTime(ctx)) break;
    }
    return { patch: cache };
  }

  // Backfill: stable order, resumable by position.
  entries.sort((a, b) => a.loc.localeCompare(b.loc));
  let bf = { ...source.backfill, discovered: entries.length };
  let i = Number(bf.cursor ?? 0) || 0;
  for (; i < entries.length; i++) {
    const e = entries[i]!;
    if (await needsFetch(deps, source, e)) {
      if (QUEUED.has(await handle(ctx, { url: e.loc, modifiedAt: e.lastmod }))) bf.queued += 1;
    } else {
      ctx.counts.unchanged += 1;
    }
    if ((i + 1) % 25 === 0) await deps.store.updateSource(source.id, { backfill: { ...bf, cursor: String(i + 1) } });
    if (outOfTime(ctx) && i + 1 < entries.length) {
      bf = { ...bf, cursor: String(i + 1) };
      return { patch: { ...cache, backfill: bf } };
    }
  }
  return { patch: { ...cache, backfill: { ...bf, status: 'done', cursor: null, finishedAt: deps.now() } } };
}

// ------------------------------------------------------------------- Due

/** Called by Cloud Scheduler every 5 minutes: runs every due source until the time budget is used. */
export async function runDue(deps: Deps): Promise<RunSummary[]> {
  const now = deps.now();
  const deadline = now.getTime() + deps.cfg.runBudgetMs;
  const due = (await deps.store.listActiveSources())
    .filter((s) => isDue(s, now))
    .sort((a, b) => {
      const rank = (s: Source) => (s.syncRequestedAt ? 0 : s.backfill.status === 'running' || s.backfill.status === 'pending' ? 1 : 2);
      return rank(a) - rank(b) || (a.lastFetchedAt?.getTime() ?? 0) - (b.lastFetchedAt?.getTime() ?? 0);
    });

  const out: RunSummary[] = [];
  for (const s of due) {
    if (deps.now().getTime() >= deadline) break;
    out.push(await runSource(deps, s.id, undefined, deadline));
  }
  return out;
}
