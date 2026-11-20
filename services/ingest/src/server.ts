// ingest: fetch RSS/sitemaps, accept uploads, store raw files, emit content.raw.
// The only service that mints document IDs (docIdFor in @fairsource/shared).
//
//   INGEST_BACKEND=memory npm run dev -w services/ingest   # no Google Cloud needed
//
// See "Ingestion service" and "Keeping sources in sync" in the Technical Implementation doc.

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { jsonLog, type Deps } from './deps.js';
import { gcpBackend } from './gcp.js';
import { Fetcher } from './http.js';
import { MemoryBlobs, MemoryBus, MemoryStore } from './memory.js';
import { RobotsCache } from './robots.js';

const cfg = loadConfig();
const backend =
  process.env.INGEST_BACKEND === 'memory' ? { store: new MemoryStore(), blobs: new MemoryBlobs(), bus: new MemoryBus() } : gcpBackend(cfg);
const fetcher = new Fetcher(cfg);

const deps: Deps = {
  cfg,
  ...backend,
  fetcher,
  robots: new RobotsCache(fetcher),
  now: () => new Date(),
  log: jsonLog,
};

const app = buildApp(deps);
const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: '0.0.0.0' });
jsonLog({ event: 'listening', port, backend: process.env.INGEST_BACKEND === 'memory' ? 'memory' : 'gcp' });
