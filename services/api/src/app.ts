// HTTP routes for the licensed API (/v1). Errors use the codes in the
// Technical Implementation doc: 400 invalid_request, 401 invalid_key,
// 403 scope, 404 not_found, 429 rate_limited / quota_exceeded, 503 upstream.

import { timingSafeEqual } from 'node:crypto';
import { SCHEMA_VERSION, openApiSpec } from '@fairsource/shared';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { KeyAuth, RateLimiter, quotaLeft, type Caller } from './auth.js';
import { localDate } from './meter.js';
import type { Endpoint, Scope } from './ports.js';
import { ApiError, LicenceCache, answer, getDocument, restamp, search, usage, type Deps } from './service.js';

const Lang = z.string().regex(/^[a-z]{2,3}$/);
const SearchBody = z.object({
  query: z.string().trim().min(1).max(2000),
  languages: z.array(Lang).max(10).optional(),
  limit: z.number().int().min(1).max(10).default(5),
  use: z.enum(['rag', 'training']).default('rag'),
});
const AnswerBody = z.object({
  question: z.string().trim().min(1).max(2000),
  answerLanguage: Lang.default('en'),
  maxSources: z.number().int().min(1).max(8).default(5),
  languages: z.array(Lang).max(10).optional(),
});
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const UsageQuery = z.object({ from: Day.optional(), to: Day.optional() });
const RestampBody = z.union([z.object({ documentId: z.string().min(1) }), z.object({ publisherId: z.string().min(1) })]);

export function buildApp(d: Deps) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const auth = new KeyAuth(d.store, d.cfg.keyCacheMs, d.now);
  const limiter = new RateLimiter(d.cfg.requestsPerMinute, d.now);
  const licences = new LicenceCache(d.store, d.cfg.licenceCacheMs, d.now);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', issues: err.issues });
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if ((err as { statusCode?: number }).statusCode === 400) return reply.code(400).send({ error: 'invalid_request', message: (err as Error).message });
    d.log({ severity: 'ERROR', event: 'request_failed', error: err instanceof Error ? err.stack : String(err) });
    return reply.code(500).send({ error: 'internal' });
  });

  const internalOk = (req: FastifyRequest) => {
    const token = String(req.headers['x-internal-token'] ?? '');
    const expected = d.cfg.internalToken;
    return expected !== null && token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  };

  /** Key, rate limit, quota and scope checks shared by every metered route. */
  async function caller(req: FastifyRequest, scope: Scope): Promise<Caller> {
    const asBuyer = req.headers['x-fs-buyer'];
    const asKey = req.headers['x-fs-key-prefix'];
    const c =
      typeof asBuyer === 'string' && typeof asKey === 'string' && internalOk(req)
        ? await auth.authenticateAs(asBuyer, asKey) // the dashboard Playground
        : await auth.authenticate(req.headers.authorization);
    if (!c) throw new ApiError(401, 'invalid_key', 'Missing, malformed or revoked API key.');
    if (!limiter.take(c.key.prefix)) throw new ApiError(429, 'rate_limited', `Over ${d.cfg.requestsPerMinute} requests per minute for this key.`);
    if (quotaLeft(c.buyer, localDate(d.now(), d.cfg.timeZone).slice(0, 7)) <= 0) throw new ApiError(429, 'quota_exceeded', 'Monthly token quota used.');
    if (!c.key.scopes.includes(scope)) throw new ApiError(403, 'scope', `This key does not have the "${scope}" scope.`);
    return c;
  }

  const endpointOf = (req: FastifyRequest, fallback: Endpoint): Endpoint => (req.headers['x-fairsource-client'] === 'mcp' ? 'mcp' : fallback);

  const afterCharge = (c: Caller, tokens: number) => auth.noteUsage(c.buyer.id, tokens, localDate(d.now(), d.cfg.timeZone).slice(0, 7));

  // Browsers may call /v1 directly (the docs' "Test request", buyer web apps). Keys are bearer
  // tokens, not cookies, so any origin is safe; internal headers are not allowed cross-origin.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/') && !req.url.startsWith('/openapi.json')) return;
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-headers', 'authorization, content-type');
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    reply.header('access-control-max-age', '600');
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  const spec = openApiSpec({ apiBaseUrl: process.env.PUBLIC_API_URL });
  app.get('/openapi.json', async () => spec);

  app.get('/v1/health', async () => ({ ok: true, service: 'api', schemaVersion: SCHEMA_VERSION }));

  app.post('/v1/search', async (req) => {
    const c = await caller(req, 'search');
    const out = await search(d, licences, c, SearchBody.parse(req.body), endpointOf(req, 'search'));
    afterCharge(c, out.usage.tokensServed);
    return out;
  });

  app.post('/v1/answer', async (req) => {
    const c = await caller(req, 'answer');
    const out = await answer(d, licences, c, AnswerBody.parse(req.body), endpointOf(req, 'answer'));
    afterCharge(c, out.usage.tokensServed);
    return out;
  });

  app.get<{ Params: { id: string }; Querystring: { use?: string } }>('/v1/documents/:id', async (req) => {
    const c = await caller(req, 'documents');
    const use = req.query.use === 'training' ? 'training' : 'rag';
    const out = await getDocument(d, licences, c, req.params.id, use);
    afterCharge(c, out.usage.tokensServed);
    return out;
  });

  app.get('/v1/usage', async (req) => {
    const c = await auth.authenticate(req.headers.authorization);
    if (!c) throw new ApiError(401, 'invalid_key', 'Missing, malformed or revoked API key.');
    const q = UsageQuery.parse(req.query);
    return usage(d, c, q.from, q.to);
  });

  // Called by the web app after an opt-out toggle or licence save, and by ingest after a withdrawal.
  app.post('/internal/restamp', async (req, reply: FastifyReply) => {
    if (!internalOk(req)) return reply.code(404).send({ error: 'not_found' });
    return restamp(d, RestampBody.parse(req.body));
  });

  return app;
}
