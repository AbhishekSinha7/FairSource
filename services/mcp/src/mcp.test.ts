// End to end: a real MCP client -> this MCP server -> the real API app
// (in-memory backend with demo data), over HTTP on local ports.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp as buildApi } from '../../api/src/app.js';
import { loadConfig } from '../../api/src/config.js';
import { seedDemo } from '../../api/src/demo.js';
import { EchoAnswerer, HashEmbedder, MemoryBlobs, MemoryLedger, MemoryStore } from '../../api/src/memory.js';
import { buildApp } from './app.js';

const store = new MemoryStore();
const blobs = new MemoryBlobs();
const embedder = new HashEmbedder();
const ledger = new MemoryLedger();
const key = seedDemo(store, blobs, embedder);
const api = buildApi({ cfg: { ...loadConfig({}), minScore: 0.05 }, store, blobs, ledger, embedder, answerer: new EchoAnswerer(), now: () => new Date(), log: () => undefined });
let mcpUrl = '';
let mcp: ReturnType<typeof buildApp>;

before(async () => {
  await api.listen({ port: 0, host: '127.0.0.1' });
  const apiBase = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  mcp = buildApp({ apiBase });
  await mcp.listen({ port: 0, host: '127.0.0.1' });
  mcpUrl = `http://127.0.0.1:${(mcp.server.address() as AddressInfo).port}/mcp`;
});

after(async () => {
  await mcp.close();
  await api.close();
});

async function connect(authorization?: string) {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: authorization ? { authorization } : {} } });
  await client.connect(transport);
  return client;
}

describe('MCP server', () => {
  test('lists the search tool with its schema and read-only hint', async () => {
    const client = await connect(`Bearer ${key}`);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['search_licensed_content']);
    const tool = tools[0]!;
    assert.deepEqual(tool.inputSchema.required, ['query']);
    assert.equal(tool.annotations?.readOnlyHint, true);
    await client.close();
  });

  test('a Hindi question returns licensed Marathi content with attribution, metered as mcp', async () => {
    const client = await connect(`Bearer ${key}`);
    const res = await client.callTool({ name: 'search_licensed_content', arguments: { query: 'पुणे मेट्रो का नया रूट क्या है?', languages: ['mr', 'hi'], limit: 3 } });
    assert.ok(!res.isError);
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.match(text, /पुणे शहरात नवीन मेट्रो मार्ग \(Marathi/);
    assert.match(text, /Source: Example Marathi Daily, licensed via FairSource · licence rag\/IN\+GLOBAL\/v3/);
    assert.ok(ledger.rows.length > 0 && ledger.rows.every((r) => r.endpoint === 'mcp'));
    await client.close();
  });

  test('a wrong key is reported as a tool error, not a crash', async () => {
    const client = await connect(`Bearer ${key.slice(0, -4)}zzzz`);
    const res = await client.callTool({ name: 'search_licensed_content', arguments: { query: 'metro' } });
    assert.equal(res.isError, true);
    assert.match((res.content as Array<{ text: string }>)[0]!.text, /401: Your FairSource API key is missing, wrong or revoked/);
    await client.close();
  });

  test('no key at all is refused at connect time', async () => {
    await assert.rejects(connect());
    const res = await fetch(mcpUrl, { method: 'GET' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});
