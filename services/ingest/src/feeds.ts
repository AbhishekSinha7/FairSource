// RSS 2.0, RSS 1.0 (RDF) and Atom parsing, plus the next-page link used by backfill.

import { XMLParser } from 'fast-xml-parser';

export interface FeedItem {
  url?: string;
  guid?: string;
  title?: string;
  published?: Date;
  updated?: Date;
}

export interface Feed {
  kind: 'rss' | 'atom';
  title?: string;
  items: FeedItem[];
  /** RFC 5005 / Atom rel="next" page, when the feed offers one. */
  next?: string;
}

export class NotAFeedError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ['item', 'entry', 'link'].includes(name),
});

type Node = Record<string, unknown>;

const text = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object' && '#text' in (v as Node)) return text((v as Node)['#text']);
  return undefined;
};

const date = (v: unknown): Date | undefined => {
  const s = text(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** Atom-style <link href rel> elements, also used by RSS through atom:link. */
const links = (v: unknown): Array<{ href: string; rel: string; type?: string }> =>
  (Array.isArray(v) ? v : v == null ? [] : [v])
    .filter((l): l is Node => typeof l === 'object' && l !== null && '@_href' in l)
    .map((l) => ({ href: String(l['@_href']), rel: String(l['@_rel'] ?? 'alternate'), type: l['@_type'] as string | undefined }));

const resolve = (href: string | undefined, base: string): string | undefined => {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
};

export function looksLikeFeed(xml: string): boolean {
  const head = xml.slice(0, 2000).toLowerCase();
  return head.includes('<rss') || head.includes('<feed') || head.includes('<rdf:rdf');
}

export function parseFeed(xml: string, baseUrl: string): Feed {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (e) {
    throw new NotAFeedError(`not XML: ${(e as Error).message}`);
  }

  const rss = (doc.rss as Node | undefined)?.channel as Node | undefined;
  const rdf = doc.RDF as Node | undefined;
  if (rss || rdf) {
    const channel = (rss ?? (rdf?.channel as Node | undefined) ?? {}) as Node;
    const rawItems = ((rss ? rss.item : rdf?.item) ?? []) as Node[];
    const items = rawItems.map((it): FeedItem => {
      const guidNode = it.guid as Node | string | undefined;
      const guid = text(guidNode);
      const permalink = typeof guidNode === 'object' ? guidNode['@_isPermaLink'] !== 'false' : true;
      const linkText = text((it.link as unknown[] | undefined)?.find((l) => typeof l === 'string'));
      const url = resolve(linkText ?? (permalink && guid && /^https?:\/\//.test(guid) ? guid : undefined), baseUrl);
      return { url, guid, title: text(it.title), published: date(it.pubDate ?? it.date), updated: date(it.updated ?? it.modified) };
    });
    const next = links(channel.link).find((l) => l.rel === 'next')?.href;
    return { kind: 'rss', title: text(channel.title), items, next: resolve(next, baseUrl) };
  }

  const feed = doc.feed as Node | undefined;
  if (feed) {
    const entries = (feed.entry ?? []) as Node[];
    const items = entries.map((e): FeedItem => {
      const ls = links(e.link);
      const href = (ls.find((l) => l.rel === 'alternate' && (!l.type || l.type.includes('html'))) ?? ls.find((l) => l.rel === 'alternate'))?.href;
      return { url: resolve(href, baseUrl), guid: text(e.id), title: text(e.title), published: date(e.published), updated: date(e.updated) };
    });
    const next = links(feed.link).find((l) => l.rel === 'next')?.href;
    return { kind: 'atom', title: text(feed.title), items, next: resolve(next, baseUrl) };
  }

  throw new NotAFeedError('no <rss>, <rdf:RDF> or <feed> root element');
}

/**
 * WordPress serves older feed pages at ?paged=N. Used by backfill when the
 * feed has no rel="next" link.
 */
export function wordpressNextPage(currentUrl: string): string {
  const u = new URL(currentUrl);
  const page = Number(u.searchParams.get('paged') ?? '1');
  u.searchParams.set('paged', String(page + 1));
  return u.toString();
}
