// api: licensed search and RAG answers, API keys, usage events.
// Every successful call publishes usage events before it responds: nothing is served unmetered.
//
//   API_BACKEND=memory npm run dev -w services/api   # demo data, no Google Cloud needed
//
// See "Licensed API" in the Technical Implementation doc.

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { seedDemo } from './demo.js';
import { gcpBackend } from './gcp.js';
import { EchoAnswerer, HashEmbedder, MemoryBlobs, MemoryLedger, MemoryStore } from './memory.js';
import type { Deps } from './service.js';

const cfg = loadConfig();
if (process.env.API_BACKEND === 'memory' && !process.env.MIN_SCORE) cfg.minScore = 0.05; // toy embedder scores low
const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ severity: e.severity ?? 'INFO', service: 'api', ...e }));
const memory = process.env.API_BACKEND === 'memory';

let backend;
if (memory) {
  const store = new MemoryStore();
  const blobs = new MemoryBlobs();
  const embedder = new HashEmbedder(cfg.embeddingDims);
  const key = seedDemo(store, blobs, embedder);
  log({ event: 'demo_seeded', demoKey: key, note: 'local demo key, memory backend only' });
  backend = { store, blobs, ledger: new MemoryLedger(), embedder, answerer: new EchoAnswerer() };
} else {
  backend = gcpBackend(cfg);
}

const deps: Deps = { cfg, ...backend, now: () => new Date(), log };
const app = buildApp(deps);
const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: '0.0.0.0' });
log({ event: 'listening', port, backend: memory ? 'memory' : 'gcp' });
