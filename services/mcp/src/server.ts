// mcp: streamable HTTP MCP server (stateless) exposing licensed search to AI agents.
// A thin wrapper: it never reads Firestore; it calls the api service with the
// buyer's key, so rights checks and metering are identical to REST.
//
//   API_BASE=http://localhost:8080 npm run dev -w services/mcp

import { buildApp } from './app.js';

const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ severity: e.severity ?? 'INFO', service: 'mcp', ...e }));
const apiBase = (process.env.API_BASE ?? 'http://localhost:8080').replace(/\/$/, '');

const app = buildApp({ apiBase, log });
const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: '0.0.0.0' });
log({ event: 'listening', port, apiBase });
