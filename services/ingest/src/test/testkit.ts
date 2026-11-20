// Test harness: a fake website, an adjustable clock and the in-memory backend.

import { newSource, type Source, type SourceType } from '@fairsource/shared';
import { loadConfig, type IngestConfig } from '../config.js';
import type { Deps } from '../deps.js';
import { Fetcher, type FetchFn } from '../http.js';
import { MemoryBlobs, MemoryBus, MemoryStore } from '../memory.js';
import { RobotsCache } from '../robots.js';

export interface Page {
  status?: number;
  body?: string | Uint8Array;
  type?: string;
  etag?: string;
}

export class FakeWeb {
  pages = new Map<string, Page>();
  log: string[] = [];
  onRequest?: () => void;

  set(url: string, page: Page | string) {
    this.pages.set(url, typeof page === 'string' ? { body: page } : page);
  }
  remove(url: string) {
    this.pages.delete(url);
  }
  gets(fragment: string) {
    return this.log.filter((l) => l.startsWith('GET ') && l.includes(fragment)).length;
  }

  fetch: FetchFn = async (url, init) => {
    const method = init.method ?? 'GET';
    this.log.push(`${method} ${url}`);
    this.onRequest?.();
    const p = this.pages.get(url);
    if (!p) return new Response('not found', { status: 404 });
    const status = p.status ?? 200;
    const headers = new Headers({ 'content-type': p.type ?? 'text/html; charset=utf-8' });
    if (p.etag) {
      headers.set('etag', p.etag);
      if ((init.headers as Record<string, string>)['if-none-match'] === p.etag) return new Response(null, { status: 304, headers });
    }
    return new Response(method === 'HEAD' ? null : (p.body ?? ''), { status, headers });
  };
}

export function harness(over: Partial<IngestConfig> = {}) {
  const web = new FakeWeb();
  const cfg: IngestConfig = { ...loadConfig({}), minIntervalMs: 0, ...over };
  let t = new Date('2026-11-19T10:00:00Z');
  const fetcher = new Fetcher(cfg, web.fetch);
  const store = new MemoryStore();
  const blobs = new MemoryBlobs();
  const bus = new MemoryBus();
  const logs: Array<Record<string, unknown>> = [];
  const deps: Deps = {
    cfg,
    store,
    blobs,
    bus,
    fetcher,
    robots: new RobotsCache(fetcher, 'fairsourcebot', 0),
    now: () => new Date(t),
    log: (e) => logs.push(e),
  };
  return {
    web,
    deps,
    store,
    blobs,
    bus,
    logs,
    advance(ms: number) {
      t = new Date(t.getTime() + ms);
    },
    addSource(type: SourceType, url: string | null, id = `src_${type}`, publisherId = 'pub_1'): Source {
      const s = newSource({ id, publisherId, type, name: id, url, consentAt: new Date(t) });
      store.sources.set(id, s);
      return s;
    },
    /** What the worker does after processing: the pending version becomes current. */
    processAll() {
      for (const d of store.documents.values()) {
        if (d.pendingContentHash && d.status !== 'withdrawn') {
          d.contentHash = d.pendingContentHash;
          d.version += 1;
          d.status = 'done';
          d.servable = true;
        }
      }
    },
    docByPath(path: string) {
      return [...store.documents.values()].find((d) => d.sourceUrl?.endsWith(path) || d.canonicalUrl?.endsWith(path));
    },
  };
}

export const article = (canonical: string, title: string, body: string, sidebar = 'Related: nothing') =>
  `<!doctype html><html><head><title>${title}</title><link rel="canonical" href="${canonical}"></head>` +
  `<body><header>Example Daily</header><nav><a href="/">Home</a></nav>` +
  `<article><h1>${title}</h1><p>${body}</p></article>` +
  `<aside>${sidebar}</aside><script>track(${Math.random()})</script><footer>© Example</footer></body></html>`;

export const urlset = (entries: Array<[string, string?]>) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
  entries.map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`).join('') +
  `</urlset>`;

export const sitemapIndex = (children: Array<[string, string?]>) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
  children.map(([loc, lastmod]) => `<sitemap><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</sitemap>`).join('') +
  `</sitemapindex>`;

export const rss = (items: Array<{ link: string; title?: string; guid?: string }>, extra = '') =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Feed</title>${extra}` +
  items.map((i) => `<item><title>${i.title ?? 'Post'}</title><link>${i.link}</link><guid>${i.guid ?? i.link}</guid></item>`).join('') +
  `</channel></rss>`;

export const XML = 'application/xml';
