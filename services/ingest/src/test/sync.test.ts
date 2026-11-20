import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { zipSync } from 'fflate';
import { discover } from '../discover.js';
import { runDue, runSource } from '../sync.js';
import { sweepSource } from '../sweep.js';
import { cleanupWithdrawn } from '../cleanup.js';
import { UploadError, onUploadFinalized, signUpload } from '../uploads.js';
import { XML, article, harness, rss, sitemapIndex, urlset } from './testkit.js';

const SITE = 'https://example.in';
const MAP = `${SITE}/sitemap.xml`;
const POSTS = `${SITE}/sitemap-posts.xml`;
const MIN = 60_000;

/** A news site with a sitemap index and three articles. */
function newsSite() {
  const h = harness();
  const { web } = h;
  web.set(`${SITE}/robots.txt`, { body: `User-agent: *\nDisallow: /private/\nSitemap: ${MAP}`, type: 'text/plain' });
  web.set(MAP, { body: sitemapIndex([[POSTS]]), type: XML });
  const posts: Record<string, { body: string; lastmod: string }> = {
    a: { body: 'हिंजवडी ते शिवाजीनगर मेट्रो मार्गाचे काम अंतिम टप्प्यात आहे.', lastmod: '2026-11-18' },
    b: { body: 'पिंपरी-चिंचवडमध्ये पाणीपुरवठ्याचे नवे वेळापत्रक जाहीर झाले आहे.', lastmod: '2026-11-18' },
    c: { body: 'कोथरूडमध्ये नवे उद्यान नागरिकांसाठी खुले करण्यात आले आहे.', lastmod: '2026-11-18' },
  };
  const publish = () => {
    web.set(POSTS, { body: urlset(Object.entries(posts).map(([k, p]) => [`${SITE}/news/${k}`, p.lastmod])), type: XML });
    for (const [k, p] of Object.entries(posts)) web.set(`${SITE}/news/${k}`, article(`${SITE}/news/${k}`, `Post ${k}`, p.body));
  };
  publish();
  const src = h.addSource('sitemap', MAP);
  return { ...h, posts, publish, src };
}

describe('backfill and scheduled runs', () => {
  test('connecting a blog imports its existing posts once', async () => {
    const h = newsSite();
    const r = await runSource(h.deps, h.src.id);
    assert.equal(r.result, 'ran');
    assert.equal(r.mode, 'backfill');
    assert.equal(r.counts!.new, 3);
    assert.equal(h.bus.messages.length, 3);
    assert.ok(h.bus.messages.every((m) => m.reason === 'backfill' && m.schemaVersion === 2));

    const s = h.store.sources.get(h.src.id)!;
    assert.equal(s.backfill.status, 'done');
    assert.equal(s.backfill.discovered, 3);
    assert.equal(s.backfill.queued, 3);
    assert.equal(s.itemCount, 3);
    assert.equal(s.leaseUntil, null);

    const a = h.docByPath('/news/a')!;
    assert.equal(a.status, 'queued');
    assert.equal(a.version, 0);
    assert.ok(a.pendingContentHash);
    assert.equal(h.blobs.objects.size, 3);

    // Next scheduled run: nothing changed, so no article is even fetched.
    h.advance(31 * MIN);
    h.web.log = [];
    const r2 = await runSource(h.deps, h.src.id);
    assert.equal(r2.mode, 'scheduled');
    assert.equal(h.bus.messages.length, 3);
    assert.equal(h.web.gets('/news/'), 0);
  });

  test('an edit becomes a new version of the same document, still served meanwhile', async () => {
    const h = newsSite();
    await runSource(h.deps, h.src.id);
    h.processAll();
    const before = h.docByPath('/news/b')!;

    h.posts.b = { body: 'पिंपरी-चिंचवडमध्ये पाणीपुरवठ्याचे वेळापत्रक पुन्हा बदलले आहे.', lastmod: '2026-11-19' };
    h.publish();
    h.advance(31 * MIN);
    const r = await runSource(h.deps, h.src.id);

    assert.equal(r.counts!.changed, 1);
    const msg = h.bus.messages.at(-1)!;
    assert.equal(msg.docId, before.id);
    assert.equal(msg.reason, 'changed');
    const after = h.docByPath('/news/b')!;
    assert.equal(after.status, 'done');
    assert.equal(after.servable, true);
    assert.equal(after.version, 1);
    assert.notEqual(after.pendingContentHash, after.contentHash);
  });

  test('new ads, sidebars or scripts are not an edit', async () => {
    const h = newsSite();
    await runSource(h.deps, h.src.id);
    h.processAll();
    h.web.set(`${SITE}/news/a`, article(`${SITE}/news/a`, 'Post a', h.posts.a!.body, 'Sponsored: buy shoes'));
    h.posts.a!.lastmod = '2026-11-19';
    h.web.set(POSTS, { body: urlset(Object.entries(h.posts).map(([k, p]) => [`${SITE}/news/${k}`, p.lastmod])), type: XML });
    h.advance(31 * MIN);
    const r = await runSource(h.deps, h.src.id);
    assert.equal(r.counts!.unchanged, 1);
    assert.equal(h.bus.messages.length, 3);
  });

  test('a reverted edit (A -> B -> A) is sent again', async () => {
    const h = newsSite();
    await runSource(h.deps, h.src.id);
    h.processAll();
    const original = h.posts.a!.body;
    const hashA = h.docByPath('/news/a')!.contentHash;

    h.posts.a = { body: 'Edited text that was later rolled back by the editor.', lastmod: '2026-11-19T01:00:00Z' };
    h.publish();
    h.advance(31 * MIN);
    await runSource(h.deps, h.src.id);
    h.processAll();

    h.posts.a = { body: original, lastmod: '2026-11-19T02:00:00Z' };
    h.publish();
    h.advance(31 * MIN);
    const r = await runSource(h.deps, h.src.id);
    assert.equal(r.counts!.changed, 1);
    assert.equal(h.bus.messages.at(-1)!.contentHash, hashA);
  });

  test('the same post in RSS and the sitemap is one document', async () => {
    const h = newsSite();
    await runSource(h.deps, h.src.id);
    h.processAll();
    const feed = `${SITE}/feed`;
    const viaRss = 'https://www.example.in/news/a/?utm_source=rss';
    h.web.set(feed, { body: rss([{ link: viaRss, guid: 'post-a' }]), type: 'application/rss+xml' });
    h.web.set(viaRss, article(`${SITE}/news/a`, 'Post a', h.posts.a!.body));
    const feedSrc = h.addSource('rss', feed);

    const r = await runSource(h.deps, feedSrc.id);
    assert.equal(r.counts!.unchanged, 1);
    assert.equal(h.store.documents.size, 3);
    assert.deepEqual(h.docByPath('/news/a')!.sourceIds.sort(), [feedSrc.id, h.src.id].sort());
    assert.equal(h.bus.messages.length, 3);
  });

  test('robots.txt is respected', async () => {
    const h = newsSite();
    h.web.set(POSTS, { body: urlset([[`${SITE}/news/a`], [`${SITE}/private/x`]]), type: XML });
    h.web.set(`${SITE}/private/x`, article(`${SITE}/private/x`, 'Private', 'Should never be fetched by FairSource.'));
    const r = await runSource(h.deps, h.src.id);
    assert.equal(r.counts!.skipped, 1);
    assert.equal(h.web.gets('/private/x'), 0);
  });

  test('a run already in progress is skipped', async () => {
    const h = newsSite();
    await h.store.acquireLease(h.src.id, h.deps.now(), new Date(h.deps.now().getTime() + 5 * MIN));
    assert.equal((await runSource(h.deps, h.src.id)).result, 'busy');
  });

  test('a failing feed marks the source as error with the reason', async () => {
    const h = newsSite();
    h.web.set(MAP, { status: 500, body: 'oops' });
    const r = await runSource(h.deps, h.src.id);
    assert.equal(r.result, 'error');
    const s = h.store.sources.get(h.src.id)!;
    assert.equal(s.status, 'error');
    assert.match(s.lastError!, /HTTP 500/);
    assert.equal(s.leaseUntil, null);
  });
});

describe('RSS', () => {
  test('backfill follows WordPress ?paged=N until the pages run out', async () => {
    const h = harness();
    const base = 'https://blog.example.org';
    const feed = `${base}/feed`;
    const post = (n: number) => `${base}/2026/post-${n}`;
    h.web.set(feed, { body: rss([{ link: post(1) }, { link: post(2) }]), type: 'application/rss+xml' });
    h.web.set(`${feed}?paged=2`, { body: rss([{ link: post(3) }]), type: 'application/rss+xml' });
    for (const n of [1, 2, 3]) h.web.set(post(n), article(post(n), `Post ${n}`, `This is the body of blog post number ${n}, long enough to hash.`));
    const s = h.addSource('rss', feed);

    const r = await runSource(h.deps, s.id);
    assert.equal(r.counts!.new, 3);
    const after = h.store.sources.get(s.id)!;
    assert.equal(after.backfill.status, 'done');
    assert.equal(after.backfill.discovered, 3);
  });

  test('scheduled runs send the ETag and skip an unchanged feed', async () => {
    const h = harness();
    const feed = 'https://b.org/feed';
    h.web.set(feed, { body: rss([{ link: 'https://b.org/p1' }]), type: 'application/rss+xml', etag: '"v1"' });
    h.web.set('https://b.org/p1', article('https://b.org/p1', 'P1', 'A post body that is long enough to be hashed as text.'));
    const s = h.addSource('rss', feed);
    h.store.sources.get(s.id)!.backfill.status = 'done';

    await runSource(h.deps, s.id);
    assert.equal(h.store.sources.get(s.id)!.etag, '"v1"');
    h.advance(31 * MIN);
    const r = await runSource(h.deps, s.id);
    assert.equal(r.notModified, true);
  });
});

describe('deletion sweep', () => {
  test('withdraws 404s, never 5xx; a post that comes back is restored', async () => {
    const h = newsSite();
    await runSource(h.deps, h.src.id);
    h.processAll();

    // c is deleted, b is temporarily broken; both drop out of the sitemap.
    h.web.remove(`${SITE}/news/c`);
    h.web.set(`${SITE}/news/b`, { status: 503, body: 'maintenance' });
    h.web.set(POSTS, { body: urlset([[`${SITE}/news/a`, '2026-11-18']]), type: XML });
    h.advance(25 * 60 * MIN);

    const sw = await sweepSource(h.deps, h.src.id);
    assert.equal(sw.checked, 2); // only the two missing from the sitemap; a is listed and recent
    assert.equal(sw.withdrawn, 1);
    assert.equal(sw.errors, 1);
    assert.equal(sw.alive, 0);
    const c = h.docByPath('/news/c')!;
    assert.equal(c.status, 'withdrawn');
    assert.equal(c.withdrawnReason, 'http_404');
    assert.equal(c.servable, false);
    assert.equal(h.docByPath('/news/b')!.status, 'done');
    assert.equal(h.store.sources.get(h.src.id)!.itemCount, 2);

    // The publisher restores c.
    h.posts.c!.lastmod = '2026-11-20';
    h.publish();
    h.advance(31 * MIN);
    const r = await runSource(h.deps, h.src.id);
    assert.equal(r.counts!.restored, 1);
    assert.equal(h.docByPath('/news/c')!.status, 'queued');
    assert.equal(h.store.sources.get(h.src.id)!.itemCount, 3);
  });

  test('missing from a feed alone never triggers a check', async () => {
    const h = harness();
    const feed = 'https://b.org/feed';
    h.web.set(feed, { body: rss([{ link: 'https://b.org/p1' }]), type: 'application/rss+xml' });
    h.web.set('https://b.org/p1', article('https://b.org/p1', 'P1', 'A post body that is long enough to be hashed as text.'));
    const s = h.addSource('rss', feed);
    await runSource(h.deps, s.id);
    h.web.set(feed, { body: rss([]), type: 'application/rss+xml' });
    h.advance(2 * 24 * 60 * MIN);
    const sw = await sweepSource(h.deps, s.id);
    assert.equal(sw.checked, 0); // not stale yet (7 days), and feeds don't count as "missing"
  });
});

describe('resumable backfill', () => {
  test('stops at the time budget and resumes without duplicates', async () => {
    const h = harness({ runBudgetMs: 2500 });
    h.web.onRequest = () => h.advance(1000);
    const base = 'https://big.example.in';
    const urls = [1, 2, 3, 4, 5, 6].map((n) => `${base}/n/${n}`);
    h.web.set(`${base}/sitemap.xml`, { body: urlset(urls.map((u) => [u, '2026-11-01'])), type: XML });
    for (const u of urls) h.web.set(u, article(u, u, `Body for ${u}, which is long enough to be fingerprinted.`));
    const s = h.addSource('sitemap', `${base}/sitemap.xml`);

    const first = await runSource(h.deps, s.id);
    assert.equal(first.backfill!.status, 'running');
    assert.ok(Number(first.backfill!.cursor) > 0);

    for (let i = 0; i < 10 && h.store.sources.get(s.id)!.backfill.status !== 'done'; i++) await runDue(h.deps);
    assert.equal(h.store.sources.get(s.id)!.backfill.status, 'done');
    assert.equal(h.store.documents.size, 6);
    assert.equal(h.bus.messages.length, 6);
  });
});

describe('uploads', () => {
  test('a ZIP is expanded; the same file uploaded again is one document', async () => {
    const h = harness();
    const s = h.addSource('upload', null, 'src_upload');
    const pdf = new TextEncoder().encode('%PDF-1.4 scanned page one');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const zip = zipSync({ 'scans/page-1.pdf': pdf, 'scans/page-2.png': png, 'notes.txt': new TextEncoder().encode('hi'), '__MACOSX/._page-1.pdf': pdf });
    const path = `uploads/pub_1/${s.id}/u1/scans.zip`;
    h.blobs.objects.set(path, { bytes: zip, contentType: 'application/zip' });

    const r = await onUploadFinalized(h.deps, path);
    assert.equal(r.ignored, false);
    if (r.ignored) return;
    assert.deepEqual(r.outcomes.map((o) => o.outcome), ['new', 'new']);
    assert.deepEqual(r.rejected, ['notes.txt']);
    assert.equal(h.blobs.objects.has(path), false);
    assert.equal(h.bus.messages.length, 2);
    assert.equal(h.bus.messages[0]!.mimeType, 'application/pdf');
    assert.equal(h.bus.messages[0]!.sourceUrl, null);

    const again = `uploads/pub_1/${s.id}/u2/page-1.pdf`;
    h.blobs.objects.set(again, { bytes: pdf, contentType: 'application/pdf' });
    const r2 = await onUploadFinalized(h.deps, again);
    assert.ok(!r2.ignored && r2.outcomes[0]!.outcome === 'unchanged');
  });

  test('signed upload URLs are only issued for allowed files', async () => {
    const h = harness();
    const s = h.addSource('upload', null, 'src_upload');
    const ok = await signUpload(h.deps, { publisherId: 'pub_1', sourceId: s.id, filename: 'जुना अंक 1952.pdf', contentType: 'application/pdf', size: 1000 });
    assert.match(ok.path, /^uploads\/pub_1\/src_upload\/[0-9a-f-]+\/जुना_अंक_1952\.pdf$/);
    await assert.rejects(signUpload(h.deps, { publisherId: 'pub_1', sourceId: s.id, filename: 'big.pdf', contentType: 'application/pdf', size: 11 * 1024 * 1024 }), (e: unknown) => e instanceof UploadError && e.code === 'too_large');
    await assert.rejects(signUpload(h.deps, { publisherId: 'pub_1', sourceId: s.id, filename: 'a.exe', contentType: 'application/x-msdownload', size: 10 }), (e: unknown) => e instanceof UploadError && e.code === 'unsupported_type');
    await assert.rejects(signUpload(h.deps, { publisherId: 'pub_2', sourceId: s.id, filename: 'a.pdf', contentType: 'application/pdf', size: 10 }), (e: unknown) => e instanceof UploadError && e.code === 'forbidden');
  });
});

describe('feed discovery', () => {
  test('finds a feed from <link rel="alternate">, then common paths; a sitemap from robots.txt', async () => {
    const h = harness();
    h.web.set('https://a.in/', `<html><head><link rel="alternate" type="application/rss+xml" href="/news.rss"></head></html>`);
    h.web.set('https://a.in/news.rss', { body: rss([{ link: 'https://a.in/1' }]), type: 'application/rss+xml' });
    assert.deepEqual(await discover(h.deps, 'a.in', 'rss'), { url: 'https://a.in/news.rss', method: 'link_rel', title: 'Feed', items: 1 });

    h.web.set('https://b.in/', '<html><head></head></html>');
    h.web.set('https://b.in/feed', { body: rss([]), type: 'application/rss+xml' });
    assert.equal((await discover(h.deps, 'https://b.in', 'rss'))?.method, 'well_known_path');

    h.web.set('https://c.in/robots.txt', { body: 'Sitemap: https://c.in/maps/all.xml', type: 'text/plain' });
    h.web.set('https://c.in/maps/all.xml', { body: urlset([['https://c.in/x']]), type: XML });
    assert.equal((await discover(h.deps, 'c.in', 'sitemap'))?.method, 'robots_txt');

    assert.equal(await discover(h.deps, 'nothing.in', 'rss'), null);
  });
});

describe('cleanup of withdrawn posts', () => {
  test('deletes chunks and files, keeps a raw file still used by a duplicate, keeps the document row', async () => {
    const h = newsSite();
    await runSource(h.deps, h.src.id);
    h.processAll();
    const c = h.docByPath('/news/c')!;
    const b = h.docByPath('/news/b')!;
    // What the worker would have stored for c (two versions); b shares c's first raw file.
    const raw1 = 'gs://fs-raw/pub_1/2026/11/c1.html';
    const raw2 = 'gs://fs-raw/pub_1/2026/11/c2.html';
    h.store.documents.get(c.id)!.rawUri = raw2;
    h.store.documents.get(c.id)!.cleanUri = `gs://fs-clean/pub_1/${c.id}/v2.json`;
    h.store.documents.get(b.id)!.rawUri = raw1;
    h.store.versions.set(c.id, [
      { version: 1, rawUri: raw1, cleanUri: `gs://fs-clean/pub_1/${c.id}/v1.json` },
      { version: 2, rawUri: raw2, cleanUri: `gs://fs-clean/pub_1/${c.id}/v2.json` },
    ]);
    h.store.chunks.set(`${c.id}_v2_0`, { documentId: c.id });
    h.store.chunks.set(`${c.id}_v2_1`, { documentId: c.id });
    h.store.chunks.set(`${b.id}_v1_0`, { documentId: b.id });

    h.web.remove(`${SITE}/news/c`);
    h.web.set(POSTS, { body: urlset([[`${SITE}/news/a`, '2026-11-18'], [`${SITE}/news/b`, '2026-11-18']]), type: XML });
    h.advance(25 * 60 * MIN);
    await sweepSource(h.deps, h.src.id);

    const out = await cleanupWithdrawn(h.deps);
    assert.deepEqual(out, { documents: 1, chunks: 2, files: 3, keptShared: 1 });
    assert.ok(!h.blobs.deleted.includes(raw1), 'raw file shared with b is kept');
    assert.ok(h.blobs.deleted.includes(raw2));
    assert.ok(h.store.chunks.has(`${b.id}_v1_0`));
    const after = h.store.documents.get(c.id)!;
    assert.equal(after.title, 'Post c');
    assert.equal(after.rawUri, null);
    assert.ok(after.cleanedAt instanceof Date);
    assert.ok(h.store.versions.get(c.id)!.every((v) => v.rawUri === null && v.cleanUri === null));

    assert.equal((await cleanupWithdrawn(h.deps)).documents, 0, 'runs once per document');
  });
});
