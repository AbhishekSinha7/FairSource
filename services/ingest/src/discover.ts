// "Paste your site address and we'll find the feed."
// RSS: the URL itself, then <link rel="alternate">, then common paths.
// Sitemap: the URL itself, then Sitemap: lines in robots.txt, then common paths.

import type { Source } from '@fairsource/shared';
import type { Deps } from './deps.js';
import { looksLikeFeed, parseFeed } from './feeds.js';
import { feedLinksFrom } from './html.js';
import { FetchError, type FetchResult } from './http.js';
import { looksLikeSitemap, parseSitemap } from './sitemap.js';

export interface Discovery {
  url: string;
  method: NonNullable<Source['discoveredFrom']>;
  title?: string;
  items: number;
}

const FEED_PATHS = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml', '/feed/'];
const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/news-sitemap.xml', '/sitemap-news.xml'];

export function normaliseInput(input: string): string {
  const t = input.trim();
  const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error('not a web address');
  return u.toString();
}

async function fetchOk(deps: Deps, url: string): Promise<FetchResult | null> {
  if (!(await deps.robots.allowed(url))) return null;
  try {
    const res = await deps.fetcher.get(url);
    return res.status >= 200 && res.status < 300 ? res : null;
  } catch (e) {
    if (e instanceof FetchError) return null;
    throw e;
  }
}

function asFeed(res: FetchResult | null): { title?: string; items: number } | null {
  if (!res) return null;
  const body = res.text();
  if (!looksLikeFeed(body)) return null;
  try {
    const f = parseFeed(body, res.url);
    return { title: f.title, items: f.items.length };
  } catch {
    return null;
  }
}

function asSitemap(res: FetchResult | null): { items: number } | null {
  if (!res) return null;
  const body = res.text();
  if (!looksLikeSitemap(body)) return null;
  try {
    return { items: parseSitemap(body).entries.length };
  } catch {
    return null;
  }
}

export async function discover(deps: Deps, input: string, type: 'rss' | 'sitemap'): Promise<Discovery | null> {
  const start = normaliseInput(input);
  const origin = new URL(start).origin;
  const first = await fetchOk(deps, start);

  if (type === 'rss') {
    const direct = asFeed(first);
    if (direct) return { url: first!.url, method: 'manual', ...direct };
    if (first && first.contentType.includes('html')) {
      for (const link of feedLinksFrom(first.text(), first.url)) {
        const res = await fetchOk(deps, link);
        const f = asFeed(res);
        if (f) return { url: res!.url, method: 'link_rel', ...f };
      }
    }
    for (const p of FEED_PATHS) {
      const res = await fetchOk(deps, origin + p);
      const f = asFeed(res);
      if (f) return { url: res!.url, method: 'well_known_path', ...f };
    }
    return null;
  }

  const direct = asSitemap(first);
  if (direct) return { url: first!.url, method: 'manual', ...direct };
  for (const sm of (await deps.robots.get(start)).sitemaps) {
    const res = await fetchOk(deps, sm);
    const s = asSitemap(res);
    if (s) return { url: res!.url, method: 'robots_txt', ...s };
  }
  for (const p of SITEMAP_PATHS) {
    const res = await fetchOk(deps, origin + p);
    const s = asSitemap(res);
    if (s) return { url: res!.url, method: 'well_known_path', ...s };
  }
  return null;
}
