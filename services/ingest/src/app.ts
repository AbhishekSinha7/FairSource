// HTTP routes. Internal routes are protected by Cloud Run IAM (only
// sa-scheduler, Eventarc and the web app's service account are invokers),
// not by checks in this code.

import { newSource } from '@fairsource/shared';
import Fastify from 'fastify';
import { z } from 'zod';
import type { Deps } from './deps.js';
import { discover } from './discover.js';
import { MemoryBlobs, MemoryBus, MemoryStore } from './memory.js';
import { runDue, runSource } from './sync.js';
import { cleanupWithdrawn } from './cleanup.js';
import { sweepAll, sweepSource } from './sweep.js';
import { UploadError, onUploadFinalized, signUpload } from './uploads.js';
import { SCHEMA_VERSION } from '@fairsource/shared';

const RunBody = z.object({ sourceId: z.string().min(1), mode: z.enum(['scheduled', 'manual', 'backfill']).optional() });
const SweepBody = z.object({ sourceId: z.string().min(1).optional() });
const DiscoverBody = z.object({ url: z.string().min(3), type: z.enum(['rss', 'sitemap']) });
const SignBody = z.object({
  publisherId: z.string().min(1),
  sourceId: z.string().min(1),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1),
  size: z.number().int().positive(),
});
/** Eventarc delivers the Cloud Storage object as the CloudEvent body. */
const FinalizedBody = z.object({ bucket: z.string(), name: z.string() });
const DevSourceBody = z.object({ type: z.enum(['rss', 'sitemap', 'upload']), url: z.string().url().nullable().optional(), name: z.string().optional(), publisherId: z.string().default('pub_dev') });

export function buildApp(deps: Deps) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', issues: err.issues });
    if (err instanceof UploadError) return reply.code(err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 400).send({ error: err.code, message: err.message });
    deps.log({ severity: 'ERROR', event: 'request_failed', error: err instanceof Error ? err.message : String(err) });
    return reply.code(500).send({ error: 'internal' });
  });

  app.get('/health', async () => ({ ok: true, service: 'ingest', schemaVersion: SCHEMA_VERSION }));

  // Cloud Scheduler, every 5 minutes. Each source runs when it is due (scheduleMins),
  // when "Sync now" was pressed, or while its backfill is unfinished.
  app.post('/internal/run-due', async () => ({ runs: await runDue(deps) }));

  app.post('/internal/run', async (req) => {
    const b = RunBody.parse(req.body);
    return runSource(deps, b.sourceId, b.mode);
  });

  // Cloud Scheduler, daily: find deleted posts, then delete the stored content of withdrawn ones.
  app.post('/internal/sweep', async (req) => {
    const b = SweepBody.parse(req.body ?? {});
    if (b.sourceId) return sweepSource(deps, b.sourceId);
    const sweeps = await sweepAll(deps);
    return { sweeps, cleanup: await cleanupWithdrawn(deps) };
  });

  app.post('/internal/cleanup', async () => cleanupWithdrawn(deps));

  app.post('/internal/discover', async (req, reply) => {
    const b = DiscoverBody.parse(req.body);
    let found;
    try {
      found = await discover(deps, b.url, b.type);
    } catch {
      return reply.code(400).send({ error: 'invalid_url', message: 'Enter a web address, like example.in/feed or example.in.' });
    }
    return found ? { found: true, ...found } : reply.code(404).send({ found: false, message: `No ${b.type === 'rss' ? 'feed' : 'sitemap'} found at that address.` });
  });

  app.post('/uploads/sign', async (req) => signUpload(deps, SignBody.parse(req.body)));

  app.post('/internal/upload-finalized', async (req) => {
    const b = FinalizedBody.parse(req.body);
    return onUploadFinalized(deps, b.name);
  });

  // Local development only (INGEST_BACKEND=memory): add a source and inspect state.
  if (deps.store instanceof MemoryStore) {
    const store = deps.store;
    app.post('/dev/sources', async (req) => {
      const b = DevSourceBody.parse(req.body);
      const id = `src_${Math.random().toString(36).slice(2, 10)}`;
      const s = newSource({ id, publisherId: b.publisherId, type: b.type, name: b.name ?? b.url ?? 'Uploads', url: b.url ?? null, consentAt: deps.now() });
      store.sources.set(id, s);
      return s;
    });
    app.get('/dev/state', async () => ({
      sources: [...store.sources.values()],
      documents: [...store.documents.values()],
      messages: deps.bus instanceof MemoryBus ? deps.bus.messages : [],
      objects: deps.blobs instanceof MemoryBlobs ? [...deps.blobs.objects.keys()] : [],
    }));
  }

  return app;
}
