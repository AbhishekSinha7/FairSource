// Just enough HTML handling for ingest: the canonical URL, feed links, and a
// stable text fingerprint of the article for change detection. Real content
// extraction (trafilatura + Gemini) happens in the worker.

type Attrs = Record<string, string>;

const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(tag: string): Attrs {
  const out: Attrs = {};
  const inner = tag.replace(/^<\w+/, '').replace(/\/?>$/, '');
  for (const m of inner.matchAll(ATTR)) out[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}

function linkTags(html: string): Attrs[] {
  const head = html.slice(0, 200_000);
  return [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => parseAttrs(m[0]));
}

const relHas = (a: Attrs, rel: string) => (a.rel ?? '').toLowerCase().split(/\s+/).includes(rel);
const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '');

/** The page's <link rel="canonical">, only when it points at the same site. */
export function canonicalFrom(html: string, pageUrl: string): string | null {
  const page = new URL(pageUrl);
  for (const a of linkTags(html)) {
    if (!relHas(a, 'canonical') || !a.href) continue;
    try {
      const u = new URL(a.href, page);
      if (sameSite(u, page) && /^https?:$/.test(u.protocol)) return u.toString();
    } catch {
      /* ignore bad href */
    }
  }
  return null;
}

/** <link rel="alternate" type="application/rss+xml|atom+xml"> feed URLs, in page order. */
export function feedLinksFrom(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const a of linkTags(html)) {
    const type = (a.type ?? '').toLowerCase();
    if (!relHas(a, 'alternate') || !a.href || !/(rss|atom)\+xml|application\/feed\+json/.test(type)) continue;
    if (type.includes('json')) continue;
    try {
      out.push(new URL(a.href, pageUrl).toString());
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** <title>, used as a placeholder until the worker extracts the real one. */
export function titleFrom(html: string): string | undefined {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const t = m ? decodeEntities(m[1]!).replace(/\s+/g, ' ').trim() : '';
  return t || undefined;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return NAMED[code.toLowerCase()] ?? all;
  });
}

function innerOf(html: string, tag: string): string | null {
  const open = html.search(new RegExp(`<${tag}\\b`, 'i'));
  if (open < 0) return null;
  const close = html.toLowerCase().lastIndexOf(`</${tag}>`);
  return close > open ? html.slice(open, close) : html.slice(open);
}

/**
 * Article text for change detection. Scripts, styles, navigation, header,
 * footer and sidebars are dropped, so a new ad or "related posts" list does
 * not look like an edit. Prefers <article>, then <main>, then <body>.
 */
export function mainText(html: string): string {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ');
  h = innerOf(h, 'article') ?? innerOf(h, 'main') ?? innerOf(h, 'body') ?? h;
  for (let i = 0; i < 3; i++) h = h.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  return decodeEntities(h.replace(/<[^>]+>/g, ' '))
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}
