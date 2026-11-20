// sitemap.xml, sitemap index and Google News sitemaps.

import { XMLParser } from 'fast-xml-parser';

export interface SitemapEntry {
  loc: string;
  lastmod?: Date;
}

export type Sitemap = { kind: 'index'; entries: SitemapEntry[] } | { kind: 'urlset'; entries: SitemapEntry[] };

export class NotASitemapError extends Error {}

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, isArray: (n) => n === 'url' || n === 'sitemap' });

type Node = Record<string, unknown>;

function entry(n: Node): SitemapEntry | null {
  const loc = typeof n.loc === 'string' ? n.loc.trim() : null;
  if (!loc || !/^https?:\/\//i.test(loc)) return null;
  const raw = (n.lastmod ?? (n.news as Node | undefined)?.publication_date) as string | undefined;
  const d = raw ? new Date(String(raw).trim()) : undefined;
  return { loc, lastmod: d && !Number.isNaN(d.getTime()) ? d : undefined };
}

export function looksLikeSitemap(xml: string): boolean {
  const head = xml.slice(0, 2000).toLowerCase();
  return head.includes('<urlset') || head.includes('<sitemapindex');
}

export function parseSitemap(xml: string): Sitemap {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (e) {
    throw new NotASitemapError(`not XML: ${(e as Error).message}`);
  }
  const index = doc.sitemapindex as Node | undefined;
  if (index) return { kind: 'index', entries: ((index.sitemap ?? []) as Node[]).map(entry).filter((e): e is SitemapEntry => !!e) };
  const urlset = doc.urlset as Node | undefined;
  if (urlset) return { kind: 'urlset', entries: ((urlset.url ?? []) as Node[]).map(entry).filter((e): e is SitemapEntry => !!e) };
  throw new NotASitemapError('no <urlset> or <sitemapindex> root element');
}
