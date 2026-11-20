import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl, chunkIdFor, docIdFor, identityKeyFor } from './schema.js';

test('the same article gives the same canonical URL', () => {
  const want = 'https://example.in/article/1';
  for (const u of [
    'https://example.in/article/1',
    'http://WWW.Example.in/article/1/',
    'https://example.in/article/1?utm_source=x&utm_medium=rss#top',
    'https://example.in:443//article//1?fbclid=abc',
  ]) {
    assert.equal(canonicalizeUrl(u), want, u);
  }
});

test('non-default ports are kept, so different sites stay different', () => {
  assert.equal(canonicalizeUrl('http://localhost:8099/a/'), 'https://localhost:8099/a');
  assert.equal(canonicalizeUrl('http://example.in:80/a'), 'https://example.in/a');
});

test('real query parameters are kept, in a stable order', () => {
  assert.equal(canonicalizeUrl('https://example.in/a?p=2&id=7&gclid=z'), 'https://example.in/a?id=7&p=2');
});

test('RSS and sitemap entries for one post give one document', () => {
  const fromRss = identityKeyFor({ kind: 'web', url: 'https://example.in/article/1?utm_source=rss', guid: 'abc', sourceId: 'src_rss' });
  const fromSitemap = identityKeyFor({ kind: 'web', url: 'https://www.example.in/article/1/', sourceId: 'src_map' });
  assert.equal(docIdFor(fromRss), docIdFor(fromSitemap));
});

test('GUID-only items are scoped to their feed', () => {
  const a = identityKeyFor({ kind: 'web', guid: '42', sourceId: 'src_a' });
  const b = identityKeyFor({ kind: 'web', guid: '42', sourceId: 'src_b' });
  assert.notEqual(docIdFor(a), docIdFor(b));
});

test('document IDs are 32 hex characters and chunk IDs carry the version', () => {
  const id = docIdFor('url:https://example.in/article/1');
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(chunkIdFor(id, 2, 3), `${id}_v2_3`);
});
