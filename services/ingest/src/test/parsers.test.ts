import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeed, wordpressNextPage } from '../feeds.js';
import { canonicalFrom, feedLinksFrom, mainText, titleFrom } from '../html.js';
import { parseRobots } from '../robots.js';
import { parseSitemap } from '../sitemap.js';

test('robots: most specific group wins, longest rule wins, Allow wins a tie', () => {
  const r = parseRobots(
    [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: FairSourceBot',
      'Disallow: /private/',
      'Allow: /private/press/',
      'Disallow: /*.pdf$',
      'Sitemap: https://example.in/sitemap.xml',
    ].join('\n'),
  );
  assert.equal(r.allowed('https://example.in/news/a'), true);
  assert.equal(r.allowed('https://example.in/private/x'), false);
  assert.equal(r.allowed('https://example.in/private/press/release'), true);
  assert.equal(r.allowed('https://example.in/files/a.pdf'), false);
  assert.equal(r.allowed('https://example.in/files/a.pdf?x=1'), true);
  assert.deepEqual(r.sitemaps, ['https://example.in/sitemap.xml']);
});

test('robots: falls back to the * group; empty Disallow allows everything', () => {
  assert.equal(parseRobots('User-agent: *\nDisallow: /admin').allowed('https://e.in/admin/x'), false);
  assert.equal(parseRobots('User-agent: *\nDisallow:').allowed('https://e.in/anything'), true);
  assert.equal(parseRobots('User-agent: OtherBot\nDisallow: /').allowed('https://e.in/x'), true);
});

test('RSS 2.0: link, permalink GUID fallback, dates, atom:link rel=next', () => {
  const f = parseFeed(
    `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>पुणे बातम्या</title>
      <link>https://example.in/</link><atom:link rel="next" href="/feed?paged=2"/>
      <item><title>One &amp; two</title><link>https://example.in/news/1</link><guid isPermaLink="false">post-1</guid><pubDate>Tue, 18 Nov 2026 09:00:00 +0530</pubDate></item>
      <item><title>No link</title><guid>https://example.in/news/2</guid></item>
    </channel></rss>`,
    'https://example.in/feed',
  );
  assert.equal(f.kind, 'rss');
  assert.equal(f.title, 'पुणे बातम्या');
  assert.equal(f.items[0]!.url, 'https://example.in/news/1');
  assert.equal(f.items[0]!.guid, 'post-1');
  assert.equal(f.items[0]!.title, 'One & two');
  assert.equal(f.items[0]!.published?.toISOString(), '2026-11-18T03:30:00.000Z');
  assert.equal(f.items[1]!.url, 'https://example.in/news/2');
  assert.equal(f.next, 'https://example.in/feed?paged=2');
});

test('Atom: alternate link, updated date, rel=next', () => {
  const f = parseFeed(
    `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><link rel="next" href="https://b.org/atom?page=2"/>
      <entry><id>tag:b.org,2026:1</id><title>Hello</title><link rel="alternate" type="text/html" href="/2026/hello"/><link rel="edit" href="/x"/><updated>2026-11-17T10:00:00Z</updated></entry>
    </feed>`,
    'https://b.org/atom',
  );
  assert.equal(f.kind, 'atom');
  assert.equal(f.items[0]!.url, 'https://b.org/2026/hello');
  assert.equal(f.items[0]!.updated?.toISOString(), '2026-11-17T10:00:00.000Z');
  assert.equal(f.next, 'https://b.org/atom?page=2');
});

test('RSS 1.0 (RDF) feeds parse', () => {
  const f = parseFeed(
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>Old</title></channel>
      <item><title>A</title><link>https://o.org/a</link></item></rdf:RDF>`,
    'https://o.org/rss',
  );
  assert.equal(f.items[0]!.url, 'https://o.org/a');
});

test('WordPress next page', () => {
  assert.equal(wordpressNextPage('https://b.org/feed'), 'https://b.org/feed?paged=2');
  assert.equal(wordpressNextPage('https://b.org/feed?paged=2'), 'https://b.org/feed?paged=3');
});

test('sitemaps: urlset, index and Google News publication_date', () => {
  const u = parseSitemap(
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
      <url><loc> https://e.in/a </loc><lastmod>2026-11-18</lastmod></url>
      <url><loc>https://e.in/b</loc><news:news><news:publication_date>2026-11-19T08:00:00+05:30</news:publication_date></news:news></url>
      <url><loc>not-a-url</loc></url></urlset>`,
  );
  assert.equal(u.kind, 'urlset');
  assert.deepEqual(u.entries.map((e) => e.loc), ['https://e.in/a', 'https://e.in/b']);
  assert.equal(u.entries[1]!.lastmod?.toISOString(), '2026-11-19T02:30:00.000Z');

  const i = parseSitemap(`<sitemapindex><sitemap><loc>https://e.in/s1.xml</loc></sitemap></sitemapindex>`);
  assert.equal(i.kind, 'index');
  assert.equal(i.entries.length, 1);
});

test('html: canonical only when same site; feed links; title', () => {
  const page = `<html><head><title>पुणे &amp; मेट्रो</title><link rel="canonical" href="/news/a"><link rel="alternate" type="application/rss+xml" href="/feed"></head></html>`;
  assert.equal(canonicalFrom(page, 'https://www.example.in/news/a?utm_source=x'), 'https://www.example.in/news/a');
  assert.equal(canonicalFrom(`<link href="https://other.com/a" rel="canonical">`, 'https://example.in/a'), null);
  assert.deepEqual(feedLinksFrom(page, 'https://example.in/'), ['https://example.in/feed']);
  assert.equal(titleFrom(page), 'पुणे & मेट्रो');
});

test('html: article text ignores navigation, sidebars, scripts and ads', () => {
  const a = `<body><nav>Menu</nav><article><h1>Title</h1><p>Body&nbsp;text</p><aside>Ad 1</aside></article><footer>x</footer><script>a()</script></body>`;
  const b = `<body><nav>Other menu</nav><article><h1>Title</h1>  <p>Body text</p><aside>Ad 2</aside></article><script>b()</script></body>`;
  assert.equal(mainText(a), 'Title Body text');
  assert.equal(mainText(a), mainText(b));
});

test('full-text feeds with thousands of escaped HTML entities parse (Blogger, WordPress)', () => {
  const body = '&lt;p&gt;पुणे मेट्रो &amp; बातम्या&lt;/p&gt;'.repeat(400); // 2,000 entities in one post
  const xml = `<?xml version='1.0' encoding='UTF-8'?><?xml-stylesheet href="http://www.blogger.com/styles/atom.css" type="text/css"?>` +
    `<feed xmlns='http://www.w3.org/2005/Atom'><title>Blog</title>` +
    [1, 2, 3].map((n) => `<entry><id>tag:b,${n}</id><title>Post ${n}</title><content type='html'>${body}</content><link rel='alternate' type='text/html' href='https://b.blogspot.com/p${n}.html'/></entry>`).join('') +
    `</feed>`;
  const f = parseFeed(xml, 'https://b.blogspot.com/feeds/posts/default');
  assert.equal(f.items.length, 3);
  assert.equal(f.items[2]!.url, 'https://b.blogspot.com/p3.html');
});

test('large sitemaps with &amp; in many URLs parse', () => {
  const urls = Array.from({ length: 1500 }, (_, i) => `<url><loc>https://e.in/a?x=1&amp;id=${i}</loc></url>`).join('');
  const s = parseSitemap(`<urlset>${urls}</urlset>`);
  assert.equal(s.entries.length, 1500);
  assert.equal(s.entries[1499]!.loc, 'https://e.in/a?x=1&id=1499');
});

test('entity bombs stay harmless', () => {
  // Nested ("billion laughs"): the parser doesn't expand entities inside entities.
  const lol = ['<!ENTITY a0 "lol">', ...Array.from({ length: 12 }, (_, i) => `<!ENTITY a${i + 1} "${`&a${i};`.repeat(10)}">`)].join('');
  const nested = parseFeed(`<?xml version="1.0"?><!DOCTYPE feed [${lol}]><feed><title>&a12;</title></feed>`, 'https://evil.example/feed');
  assert.ok((nested.title ?? '').length < 100);
  // Flat (one big entity repeated): rejected by the total-length cap.
  const flat = `<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY big "${'x'.repeat(9000)}">]><feed><title>${'&big;'.repeat(5000)}</title></feed>`;
  assert.throws(() => parseFeed(flat, 'https://evil.example/feed'));
});
