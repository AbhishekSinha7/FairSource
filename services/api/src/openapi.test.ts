// Keeps the published API docs (packages/shared/src/openapi.ts) true to the code:
// documented routes exist, documented examples and limits match the real
// validation, and real responses have every field the spec promises.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openApiSpec } from '@fairsource/shared';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { DEMO_DOCS, seedDemo } from './demo.js';
import { EchoAnswerer, HashEmbedder, MemoryBlobs, MemoryLedger, MemoryStore } from './memory.js';

type Schema = Record<string, unknown>;
const spec = openApiSpec() as { openapi: string; paths: Record<string, Record<string, Schema>>; components: { schemas: Record<string, Schema> } };

function resolve(s: Schema): Schema {
  const ref = s.$ref as string | undefined;
  return ref ? resolve(spec.components.schemas[ref.split('/').pop()!]!) : s;
}

/** Checks required fields and basic types, recursively. Returns the problems found. */
function check(value: unknown, schema: Schema, path = '$'): string[] {
  const s = resolve(schema);
  const types = ([] as string[]).concat((s.type as string | string[] | undefined) ?? []);
  if (value === null) return types.includes('null') || !types.length ? [] : [`${path}: null not allowed`];
  const actual = Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;
  if (types.length && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return [`${path}: expected ${types.join('|')}, got ${actual}`];
  const out: string[] = [];
  if (actual === 'object') {
    const v = value as Record<string, unknown>;
    for (const r of (s.required as string[] | undefined) ?? []) if (!(r in v)) out.push(`${path}.${r}: missing`);
    for (const [k, sub] of Object.entries((s.properties as Record<string, Schema> | undefined) ?? {})) if (k in v) out.push(...check(v[k], sub, `${path}.${k}`));
  }
  if (actual === 'array' && s.items) (value as unknown[]).forEach((x, i) => out.push(...check(x, s.items as Schema, `${path}[${i}]`)));
  if (s.enum && !(s.enum as unknown[]).includes(value)) out.push(`${path}: ${String(value)} not in enum`);
  return out;
}

function setup() {
  const store = new MemoryStore();
  const blobs = new MemoryBlobs();
  const embedder = new HashEmbedder();
  const key = seedDemo(store, blobs, embedder);
  const app = buildApp({
    cfg: { ...loadConfig({}), minScore: 0.05 },
    store,
    blobs,
    ledger: new MemoryLedger(),
    embedder,
    answerer: new EchoAnswerer(),
    now: () => new Date('2026-11-19T06:00:00Z'),
    log: () => undefined,
  });
  const headers = { authorization: `Bearer ${key}` };
  return { app, headers };
}

const op = (path: string, method: string) => spec.paths[path]![method]! as Schema & { requestBody?: Schema; responses: Record<string, Schema> };
const bodyExamples = (path: string) => {
  const c = (op(path, 'post').requestBody as { content: { 'application/json': { example?: unknown; examples?: Record<string, { value: unknown }> } } }).content['application/json'];
  return c.examples ? Object.values(c.examples).map((e) => e.value) : [c.example];
};
const okSchema = (path: string, method: string) => (op(path, method).responses['200'] as { content: { 'application/json': { schema: Schema } } }).content['application/json'].schema;

describe('OpenAPI spec', () => {
  test('is OpenAPI 3.1 and served at /openapi.json', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().openapi, '3.1.0');
    assert.deepEqual(Object.keys(res.json().paths).sort(), Object.keys(spec.paths).sort());
  });

  test('every documented operation is a real route', () => {
    const { app } = setup();
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods)) {
        assert.ok(app.hasRoute({ method: method.toUpperCase() as 'GET', url: path.replace(/\{(\w+)\}/g, ':$1') }), `${method.toUpperCase()} ${path} is not registered`);
      }
    }
  });

  test('documented request examples are accepted and responses match the schemas', async () => {
    const { app, headers } = setup();
    for (const path of ['/v1/search', '/v1/answer']) {
      for (const example of bodyExamples(path)) {
        const res = await app.inject({ method: 'POST', url: path, headers, payload: example as object });
        assert.equal(res.statusCode, 200, `${path} example rejected: ${res.body}`);
        assert.deepEqual(check(res.json(), okSchema(path, 'post')), [], path);
      }
    }
    const doc = await app.inject({ method: 'GET', url: `/v1/documents/${DEMO_DOCS[0]!.id}`, headers });
    assert.deepEqual(check(doc.json(), okSchema('/v1/documents/{id}', 'get')), []);
    const usage = await app.inject({ method: 'GET', url: '/v1/usage', headers });
    assert.deepEqual(check(usage.json(), okSchema('/v1/usage', 'get')), []);
    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    assert.deepEqual(check(health.json(), okSchema('/v1/health', 'get')), []);
  });

  test('documented limits are the enforced limits', async () => {
    const { app, headers } = setup();
    const search = spec.components.schemas.SearchRequest!.properties as Record<string, Schema>;
    const answer = spec.components.schemas.AnswerRequest!.properties as Record<string, Schema>;
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
    assert.equal((await post('/v1/search', { query: 'x', limit: search.limit!.maximum })).statusCode, 200);
    assert.equal((await post('/v1/search', { query: 'x', limit: (search.limit!.maximum as number) + 1 })).statusCode, 400);
    assert.equal((await post('/v1/search', { query: 'x'.repeat(search.query!.maxLength as number) })).statusCode, 200);
    assert.equal((await post('/v1/search', { query: 'x'.repeat((search.query!.maxLength as number) + 1) })).statusCode, 400);
    assert.equal((await post('/v1/answer', { question: 'x', maxSources: (answer.maxSources!.maximum as number) + 1 })).statusCode, 400);
    const bad = await post('/v1/search', { query: '' });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(check(bad.json(), spec.components.schemas.ValidationError!), []);
  });

  test('documented error codes are the ones returned', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/search', payload: { query: 'x' } });
    assert.equal(res.statusCode, 401);
    const codes = ((op('/v1/search', 'post').responses['401'] as { content: { 'application/json': { schema: Schema } } }).content['application/json'].schema.properties as Record<string, Schema>).error!.enum as string[];
    assert.ok(codes.includes(res.json().error));
  });

  test('browsers can call /v1 from the docs (CORS), but not internal routes', async () => {
    const { app } = setup();
    const pre = await app.inject({ method: 'OPTIONS', url: '/v1/search', headers: { origin: 'https://docs.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers['access-control-allow-origin'], '*');
    assert.match(String(pre.headers['access-control-allow-headers']), /authorization/);
    assert.doesNotMatch(String(pre.headers['access-control-allow-headers']), /x-internal-token/);
    const internal = await app.inject({ method: 'OPTIONS', url: '/internal/restamp' });
    assert.equal(internal.headers['access-control-allow-origin'], undefined);
  });
});
