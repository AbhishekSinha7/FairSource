// Streamable HTTP MCP endpoint, stateless: a fresh server and transport per
// request, so any Cloud Run instance can answer any request.

import { SCHEMA_VERSION } from '@fairsource/shared';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify from 'fastify';
import { buildMcpServer, type FetchFn } from './tools.js';

const rpcError = (message: string, code = -32001) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

export function buildApp(opts: { apiBase: string; fetchFn?: FetchFn; log?: (e: Record<string, unknown>) => void }) {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const log = opts.log ?? (() => undefined);

  // Tool results are per buyer and metered: never cached by Firebase Hosting's CDN.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/health', async () => ({ ok: true, service: 'mcp', schemaVersion: SCHEMA_VERSION }));

  app.post('/mcp', async (req, reply) => {
    const authorization = req.headers.authorization;
    if (!authorization || !/^Bearer\s+fs_/i.test(authorization)) {
      return reply.code(401).header('www-authenticate', 'Bearer').send(rpcError('Add "Authorization: Bearer <your FairSource API key>" to the MCP server config.'));
    }
    const server = buildMcpServer(opts.apiBase, authorization, opts.fetchFn);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (e) {
      log({ severity: 'ERROR', event: 'mcp_request_failed', error: (e as Error).message });
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify(rpcError('Internal error', -32603)));
      }
    }
  });

  // Stateless server: no SSE stream to resume and no session to delete.
  const notAllowed = async (_req: unknown, reply: import('fastify').FastifyReply) => reply.code(405).header('allow', 'POST').send(rpcError('Method not allowed', -32000));
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  return app;
}
