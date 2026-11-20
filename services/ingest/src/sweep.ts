// Daily deletion sweep. A document is withdrawn only when its URL returns
// 404 or 410. Missing from a feed means nothing (feeds show only recent posts);
// missing from the sitemap only makes a URL a candidate for an HTTP check.
// Timeouts, 5xx and other errors never withdraw anything.

import { canonicalizeUrl, type Source } from '@fairsource/shared';
import type { Deps } from './deps.js';
import { FetchError } from './http.js';
import type { DocSummary } from './ports.js';
import { readSitemapUrls } from './sync.js';
import { parseSitemap } from './sitemap.js';

export interface SweepSummary {
  sourceId: string;
  result: 'swept' | 'busy' | 'not_found' | 'not_runnable';
  checked?: number;
  withdrawn?: number;
  alive?: number;
  errors?: number;
  sitemapRead?: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

const canon = (url: string | null): string | null => {
  if (!url) return null;
  try {
    return canonicalizeUrl(url);
  } catch {
    return null;
  }
};

async function listedUrls(deps: Deps, source: Source): Promise<Set<string> | null> {
  if (source.type !== 'sitemap' || !source.url) return null;
  try {
    const res = await deps.fetcher.get(source.url, { accept: 'application/xml, text/xml;q=0.9, */*;q=0.5' });
    if (res.status < 200 || res.status >= 300) return null;
    const entries = await readSitemapUrls(deps, source, parseSitemap(res.text()), null);
    return new Set(entries.map((e) => canon(e.loc)).filter((u): u is string => !!u));
  } catch (e) {
    deps.log({ severity: 'WARNING', event: 'sweep_sitemap_failed', sourceId: source.id, error: (e as Error).message });
    return null;
  }
}

export async function sweepSource(deps: Deps, sourceId: string, deadline?: number): Promise<SweepSummary> {
  const { store, cfg, fetcher, robots, log } = deps;
  const start = deps.now();
  const source = await store.getSource(sourceId);
  if (!source) return { sourceId, result: 'not_found' };
  if (source.type === 'upload' || source.status === 'paused') return { sourceId, result: 'not_runnable' };
  if (!(await store.acquireLease(sourceId, start, new Date(start.getTime() + cfg.leaseMs)))) return { sourceId, result: 'busy' };

  const stop = Math.min(deadline ?? Infinity, start.getTime() + cfg.runBudgetMs);
  const summary: SweepSummary = { sourceId, result: 'swept', checked: 0, withdrawn: 0, alive: 0, errors: 0 };

  try {
    const listed = await listedUrls(deps, source);
    summary.sitemapRead = listed !== null;
    const now = start.getTime();

    const isMissing = (d: DocSummary) => listed !== null && !listed.has(canon(d.sourceUrl) ?? '') && !listed.has(d.canonicalUrl ?? '');
    const candidates = (await store.listLiveDocuments(sourceId))
      .filter((d) => d.sourceUrl)
      // Never checked: count from when we last saw it, so a post imported today isn't checked today.
      .map((d) => ({ d, missing: isMissing(d), last: (d.lastCheckedAt ?? d.lastSeenAt)?.getTime() ?? 0 }))
      .filter(({ missing, last }) => (missing && last < now - DAY) || last < now - cfg.staleCheckDays * DAY)
      .sort((a, b) => Number(b.missing) - Number(a.missing) || a.last - b.last)
      .slice(0, cfg.sweepBatch);

    for (const { d } of candidates) {
      if (deps.now().getTime() >= stop) break;
      const url = d.sourceUrl!;
      if (!(await robots.allowed(url))) continue;
      summary.checked! += 1;

      let status: number;
      try {
        status = (await fetcher.get(url, { method: 'HEAD' })).status;
        if (status === 405 || status === 501) status = (await fetcher.get(url)).status; // server does not support HEAD
      } catch (e) {
        if (!(e instanceof FetchError)) throw e;
        summary.errors! += 1;
        continue;
      }

      const t = deps.now();
      if (status === 404 || status === 410) {
        await store.updateDocument(d.id, {
          status: 'withdrawn',
          servable: false,
          withdrawnAt: t,
          withdrawnReason: status === 410 ? 'http_410' : 'http_404',
          lastCheckedAt: t,
          lastHttpStatus: status,
          cleanedAt: null, // queued for the cleanup job
        });
        await store.adjustItemCount(sourceId, -1);
        summary.withdrawn! += 1;
        log({ event: 'document_withdrawn', sourceId, docId: d.id, url, status });
      } else if (status >= 200 && status < 400) {
        await store.updateDocument(d.id, { lastCheckedAt: t, lastHttpStatus: status });
        summary.alive! += 1;
      } else {
        await store.updateDocument(d.id, { lastHttpStatus: status }); // try again next sweep
        summary.errors! += 1;
      }
    }

    if (summary.sitemapRead) await store.updateSource(sourceId, { lastFullSyncAt: deps.now() });
    log({ event: 'source_swept', ...summary });
    return summary;
  } finally {
    await store.releaseLease(sourceId);
  }
}

export async function sweepAll(deps: Deps): Promise<SweepSummary[]> {
  const deadline = deps.now().getTime() + deps.cfg.runBudgetMs;
  const out: SweepSummary[] = [];
  for (const s of await deps.store.listActiveSources()) {
    if (s.type === 'upload' || !s.url) continue;
    if (deps.now().getTime() >= deadline) break;
    out.push(await sweepSource(deps, s.id, deadline));
  }
  return out;
}
