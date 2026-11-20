import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildApp } from './app.js';
import { loadConfig, type ApiConfig } from './config.js';
import { DEMO_DOCS, seedDemo } from './demo.js';
import { EchoAnswerer, HashEmbedder, MemoryBlobs, MemoryLedger, MemoryStore } from './memory.js';

const OPTED_OUT = DEMO_DOCS.find((d) => d.over?.optOut)!.id;
const WITHDRAWN = DEMO_DOCS.find((d) => d.over?.status)!.id;
const METRO_MR = DEMO_DOCS[0]!.id;

function setup(over: Partial<ApiConfig> = {}) {
  const store = new MemoryStore();
  const blobs = new MemoryBlobs();
  const embedder = new HashEmbedder();
  const ledger = new MemoryLedger();
  const answerer = new EchoAnswerer();
  const key = seedDemo(store, blobs, embedder);
  let t = new Date('2026-11-19T06:00:00Z');
  const logs: Array<Record<string, unknown>> = [];
  // The toy hashing embedder scores lower than real embeddings, hence the low floor.
  const cfg = { ...loadConfig({}), internalToken: 'secret-token', minScore: 0.05, ...over };
  const app = buildApp({ cfg, store, blobs, ledger, embedder, answerer, now: () => new Date(t), log: (e) => logs.push(e) });
  const auth = { authorization: `Bearer ${key}` };
  const post = (url: string, payload: unknown, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url, payload: payload as object, headers });
  const get = (url: string, headers: Record<string, string> = auth) => app.inject({ method: 'GET', url, headers });
  return { app, store, ledger, answerer, key, auth, post, get, logs, advance: (ms: number) => (t = new Date(t.getTime() + ms)) };
}

const QUERY = { query: 'पुणे मेट्रो का नया रूट क्या है?', languages: ['mr', 'hi'], limit: 5 };

describe('authentication', () => {
  test('missing, malformed, wrong and revoked keys get 401', async () => {
    const s = setup();
    assert.equal((await s.post('/v1/search', QUERY, {})).statusCode, 401);
    assert.equal((await s.post('/v1/search', QUERY, { authorization: 'Bearer lcl_old_key' })).statusCode, 401);
    assert.equal((await s.post('/v1/search', QUERY, { authorization: `Bearer ${s.key.slice(0, -4)}aaaa` })).statusCode, 401);

    assert.equal((await s.post('/v1/search', QUERY)).statusCode, 200);
    s.store.keys.get(s.key.slice(3, 11))!.revokedAt = new Date();
    assert.equal((await s.post('/v1/search', QUERY)).statusCode, 200, 'cached for up to 60 s');
    s.advance(61_000);
    assert.equal((await s.post('/v1/search', QUERY)).statusCode, 401, 'revoked key stops within 60 s');
  });

  test('scope, rate limit and monthly quota', async () => {
    const s = setup({ requestsPerMinute: 2 });
    s.store.keys.get(s.key.slice(3, 11))!.scopes = ['search'];
    assert.equal((await s.post('/v1/answer', { question: 'x' })).statusCode, 403);
    assert.equal((await s.post('/v1/search', QUERY)).statusCode, 200);
    const limited = await s.post('/v1/search', QUERY);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error, 'rate_limited');

    const q = setup();
    const b = q.store.buyers.get('buy_77')!;
    b.usedTokensThisMonth = b.monthlyQuotaTokens;
    b.usageMonth = '2026-11';
    assert.equal((await q.post('/v1/search', QUERY)).json().error, 'quota_exceeded');
  });
});

describe('search', () => {
  test('Hindi query finds Marathi and Hindi articles, with attribution and licence tags', async () => {
    const s = setup();
    const res = await s.post('/v1/search', QUERY);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.requestId.startsWith('req_'));
    assert.ok(body.results.length >= 2);
    const langs = new Set(body.results.map((r: { language: string }) => r.language));
    assert.ok(langs.has('mr') && langs.has('hi'));
    const mr = body.results.find((r: { documentId: string }) => r.documentId === METRO_MR);
    assert.equal(mr.attribution.publisher, 'Example Marathi Daily');
    assert.equal(mr.attribution.licence, 'rag/IN+GLOBAL/v3');
    assert.equal(mr.attribution.text, 'Source: Example Marathi Daily, licensed via FairSource');
    assert.ok(mr.score > 0 && mr.score <= 1);
    const scores = body.results.map((r: { score: number }) => r.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });

  test('opted-out and withdrawn articles are never served, even before chunks are re-stamped', async () => {
    const s = setup();
    const ids = (await s.post('/v1/search', { ...QUERY, limit: 10 })).json().results.map((r: { documentId: string }) => r.documentId);
    assert.ok(!ids.includes(OPTED_OUT));
    assert.ok(!ids.includes(WITHDRAWN));
  });

  test('territory and use come from the live licence', async () => {
    const s = setup();
    s.store.buyers.get('buy_77')!.country = 'US';
    s.advance(11_000); // buyer cache
    const pubs = (await s.post('/v1/search', { query: 'Pune metro हिंजवडी', limit: 10 })).json().results.map((r: { attribution: { publisher: string } }) => r.attribution.publisher);
    assert.ok(!pubs.includes('Sahyadri Samachar'), 'India-only licence is not served to a US buyer');
    assert.ok(pubs.includes('Example Marathi Daily'));

    const training = (await s.post('/v1/search', { query: 'Pune wadas survey', limit: 10, use: 'training' })).json().results;
    assert.ok(training.length > 0 && training.every((r: { attribution: { publisher: string } }) => r.attribution.publisher === 'Deccan Archive Trust'));
  });

  test('a licence switched off stops serving within the licence cache time', async () => {
    const s = setup();
    assert.ok((await s.post('/v1/search', QUERY)).json().results.some((r: { documentId: string }) => r.documentId === METRO_MR));
    s.store.licences.find((l) => l.publisherId === 'pub_123')!.active = false;
    s.advance(31_000);
    assert.ok(!(await s.post('/v1/search', QUERY)).json().results.some((r: { attribution: { publisher: string } }) => r.attribution.publisher === 'Example Marathi Daily'));
  });

  test('language filter and limit', async () => {
    const s = setup();
    const res = (await s.post('/v1/search', { query: 'Pune metro line stations', languages: ['en'], limit: 1 })).json();
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].language, 'en');
  });

  test('every result is metered: one ledger row per document, live counters updated', async () => {
    const s = setup();
    const body = (await s.post('/v1/search', QUERY)).json();
    const docs = new Set(body.results.map((r: { documentId: string }) => r.documentId));
    assert.equal(s.ledger.rows.length, docs.size);
    const row = s.ledger.rows.find((r) => r.document_id === METRO_MR)!;
    assert.equal(row.buyer_id, 'buy_77');
    assert.equal(row.endpoint, 'search');
    assert.equal(row.licence_version, 3);
    assert.equal(row.document_version, 1);
    assert.equal(row.amount_micros, Math.ceil((row.tokens_served * 2000) / 1000));
    assert.equal(row.request_id, body.requestId);
    assert.equal(body.usage.tokensServed, s.ledger.rows.reduce((n, r) => n + r.tokens_served, 0));
    assert.equal(body.usage.amountMicros, s.ledger.rows.reduce((n, r) => n + r.amount_micros, 0));

    await new Promise((r) => setImmediate(r)); // counters are written after the response
    const earn = s.store.earnings.get('pub_123_20261119')!;
    assert.equal(earn.shareMicros, Math.floor((earn.grossMicros * 75) / 100));
    assert.equal(s.store.buyers.get('buy_77')!.usedTokensThisMonth, body.usage.tokensServed);
  });

  test('unrelated queries return nothing and charge nothing', async () => {
    const s = setup();
    const body = (await s.post('/v1/search', { query: 'cricket world cup final score' })).json();
    assert.equal(body.results.length, 0);
    assert.equal(body.usage.tokensServed, 0);
    assert.equal(s.ledger.rows.length, 0);
  });

  test('MCP calls are labelled endpoint = mcp', async () => {
    const s = setup();
    await s.post('/v1/search', QUERY, { ...s.auth, 'x-fairsource-client': 'mcp' });
    assert.ok(s.ledger.rows.every((r) => r.endpoint === 'mcp'));
  });

  test('if usage cannot be recorded, nothing is served', async () => {
    const s = setup();
    s.ledger.fail = true;
    const res = await s.post('/v1/search', QUERY);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().results, undefined);
  });

  test('invalid requests get 400', async () => {
    const s = setup();
    assert.equal((await s.post('/v1/search', { query: '' })).statusCode, 400);
    assert.equal((await s.post('/v1/search', { query: 'x', limit: 50 })).statusCode, 400);
  });
});

describe('answer', () => {
  test('answers from licensed sources with citations, metering every source', async () => {
    const s = setup();
    const body = (await s.post('/v1/answer', { question: 'पुणे मेट्रो का नया रूट क्या है?', answerLanguage: 'hi', maxSources: 3 })).json();
    assert.match(body.answer, /\[1\]/);
    assert.ok(body.citations.length >= 1 && body.citations[0].cited);
    assert.equal(body.citations[0].attribution.text.endsWith('licensed via FairSource'), true);
    assert.ok(s.ledger.rows.length >= 1 && s.ledger.rows.every((r) => r.endpoint === 'answer'));
  });

  test('model failure charges nothing; no sources means no model call and no charge', async () => {
    const s = setup();
    s.answerer.fail = true;
    assert.equal((await s.post('/v1/answer', { question: 'पुणे मेट्रो' })).statusCode, 503);
    assert.equal(s.ledger.rows.length, 0);

    const t = setup();
    const none = (await t.post('/v1/answer', { question: 'Pune metro', languages: ['ta'], answerLanguage: 'mr' })).json();
    assert.match(none.answer, /FairSource/);
    assert.equal(none.usage.tokensServed, 0);
    assert.equal(t.ledger.rows.length, 0);
  });
});

describe('documents and usage', () => {
  test('full licensed document, metered on its token count; unlicensed ones are 404', async () => {
    const s = setup();
    const res = await s.get(`/v1/documents/${METRO_MR}`);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.match(body.document.body, /हिंजवडी/);
    assert.equal(s.ledger.rows[0]!.endpoint, 'document');
    assert.equal(body.usage.tokensServed, s.ledger.rows[0]!.tokens_served);
    assert.equal((await s.get(`/v1/documents/${OPTED_OUT}`)).statusCode, 404);
    assert.equal((await s.get(`/v1/documents/${WITHDRAWN}`)).statusCode, 404);
    assert.equal((await s.get('/v1/documents/does-not-exist')).statusCode, 404);
  });

  test('usage shows this month by day', async () => {
    const s = setup();
    await s.post('/v1/search', QUERY);
    await s.post('/v1/search', { query: 'Pune metro' });
    await new Promise((r) => setImmediate(r));
    const u = (await s.get('/v1/usage')).json();
    assert.equal(u.from, '2026-11-01');
    assert.equal(u.totals.requests, 2);
    assert.equal(u.totals.tokens, s.ledger.rows.reduce((n, r) => n + r.tokens_served, 0));
    assert.equal(u.quota.monthlyTokens, 10_000_000);
  });
});

describe('dashboard playground', () => {
  test('acts as one of the buyer keys with the internal token, metered under that key', async () => {
    const s = setup();
    const prefix = s.key.slice(3, 11);
    const as = { 'x-internal-token': 'secret-token', 'x-fs-buyer': 'buy_77', 'x-fs-key-prefix': prefix };
    const ok = await s.post('/v1/search', QUERY, as);
    assert.equal(ok.statusCode, 200);
    assert.ok(s.ledger.rows.every((r) => r.api_key_prefix === prefix && r.buyer_id === 'buy_77'));
    assert.equal((await s.post('/v1/search', QUERY, { ...as, 'x-internal-token': 'wrong-token!' })).statusCode, 401);
    assert.equal((await s.post('/v1/search', QUERY, { ...as, 'x-fs-buyer': 'buy_other' })).statusCode, 401);
    await new Promise((r) => setImmediate(r));
    assert.equal(s.store.documentUsage.size > 0, true);
    assert.equal(s.store.recentUses.get('pub_123')![0]!.buyer, 'Kavya AI');
  });
});

describe('restamp', () => {
  test('needs the internal token; keeps chunk pre-filter fields in step with documents', async () => {
    const s = setup();
    assert.equal((await s.post('/internal/restamp', { documentId: OPTED_OUT }, {})).statusCode, 404);

    const res = await s.post('/internal/restamp', { publisherId: 'pub_123' }, { 'x-internal-token': 'secret-token' });
    assert.equal(res.statusCode, 200);
    const optedOut = [...s.store.chunks.values()].filter((c) => c.documentId === OPTED_OUT);
    assert.ok(optedOut.every((c) => c.optOut && !c.servable));
    assert.ok([...s.store.chunks.values()].filter((c) => c.documentId === WITHDRAWN).every((c) => !c.servable));

    // The publisher opts the article back in: after re-stamping it is found again.
    s.store.documents.get(OPTED_OUT)!.optOut = false;
    await s.post('/internal/restamp', { documentId: OPTED_OUT }, { 'x-internal-token': 'secret-token' });
    const ids = (await s.post('/v1/search', { query: 'मेट्रो आणि पाण्याचे नियोजन', limit: 10 })).json().results.map((r: { documentId: string }) => r.documentId);
    assert.ok(ids.includes(OPTED_OUT));
  });
});
