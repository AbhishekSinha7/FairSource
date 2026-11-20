// The MCP server: one tool, search_licensed_content, which calls the licensed
// API with the buyer's own key. Rights checks, metering and errors are the
// API's, so MCP use is billed and filtered exactly like REST (endpoint = "mcp").

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

interface SearchResult {
  documentId: string;
  score: number;
  language: string;
  text: string;
  attribution: { publisher: string; title: string; url: string | null; licence: string; text: string };
}

const LANGUAGE_NAMES: Record<string, string> = { mr: 'Marathi', hi: 'Hindi', en: 'English' };

export function formatResults(results: SearchResult[]): string {
  if (!results.length) return 'No licensed content matched this query. Try different words, or more languages.';
  const blocks = results.map((r, i) => {
    const lang = LANGUAGE_NAMES[r.language] ?? r.language;
    const link = r.attribution.url ? ` · ${r.attribution.url}` : '';
    return `[${i + 1}] ${r.attribution.title} (${lang}, relevance ${r.score})\n${r.text}\n${r.attribution.text} · licence ${r.attribution.licence}${link}`;
  });
  return `${blocks.join('\n\n')}\n\nWhen you use any of these results, show its "Source: …" line with your answer.`;
}

export function buildMcpServer(apiBase: string, authorization: string, fetchFn: FetchFn = (u, i) => fetch(u, i)): McpServer {
  const server = new McpServer(
    { name: 'fairsource', version: '0.1.0' },
    {
      instructions:
        'FairSource gives you licensed, attributed articles from Indian and other non-English publishers. ' +
        'Search in any language; results can come back in other languages. Always show the attribution line of every result you use.',
    },
  );

  server.registerTool(
    'search_licensed_content',
    {
      title: 'Search licensed content',
      description:
        'Search licensed, attributed news and articles in Indian and other non-English languages (Marathi, Hindi, English and more). ' +
        'Results carry an attribution line to show with the answer. Every call is metered against your FairSource licence.',
      inputSchema: {
        query: z.string().min(1).max(2000).describe('What to search for, in any language'),
        languages: z.array(z.string().regex(/^[a-z]{2,3}$/)).max(10).optional().describe('Only return content in these ISO 639-1 languages, e.g. ["mr", "hi"]'),
        limit: z.number().int().min(1).max(10).optional().describe('How many results, 1 to 10 (default 5)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, languages, limit }) => {
      let res: Response;
      try {
        res = await fetchFn(`${apiBase}/v1/search`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json', 'x-fairsource-client': 'mcp' },
          body: JSON.stringify({ query, languages, limit: limit ?? 5, use: 'rag' }),
        });
      } catch {
        return { isError: true, content: [{ type: 'text' as const, text: 'FairSource is unreachable right now. Try again shortly.' }] };
      }
      const body = (await res.json().catch(() => ({}))) as { results?: SearchResult[]; error?: string; message?: string };
      if (!res.ok) {
        const why = res.status === 401 ? 'Your FairSource API key is missing, wrong or revoked.' : (body.message ?? body.error ?? 'unknown error');
        return { isError: true, content: [{ type: 'text' as const, text: `FairSource API error ${res.status}: ${why}` }] };
      }
      return { content: [{ type: 'text' as const, text: formatResults(body.results ?? []) }] };
    },
  );

  return server;
}
