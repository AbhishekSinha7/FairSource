// OpenAPI 3.1 description of the public FairSource API (/v1).
// Served by the API at /openapi.json and rendered with Scalar at /docs in the
// web app. services/api/src/openapi.test.ts checks it against the real routes,
// so change both together.

export interface OpenApiOptions {
  /** e.g. "https://api.fairsource.example"; shown first in the server list. */
  apiBaseUrl?: string;
}

const ISO_LANG = { type: 'string', pattern: '^[a-z]{2,3}$', description: 'ISO 639-1 language code', examples: ['mr'] };

const errorResponse = (description: string, codes: string[], example: { error: string; message: string }) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string', enum: codes },
          message: { type: 'string' },
        },
      },
      example,
    },
  },
});

const ERRORS = {
  '400': {
    description: 'The request body or query failed validation. `issues` lists each problem.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ValidationError' },
        example: { error: 'invalid_request', issues: [{ code: 'too_big', maximum: 10, path: ['limit'], message: 'Number must be less than or equal to 10' }] },
      },
    },
  },
  '401': errorResponse('The API key is missing, malformed, wrong or revoked. A revoked key stops working within 60 seconds.', ['invalid_key'], {
    error: 'invalid_key',
    message: 'Missing, malformed or revoked API key.',
  }),
  '403': errorResponse('The key does not have the scope this endpoint needs (`search`, `answer` or `documents`).', ['scope'], {
    error: 'scope',
    message: 'This key does not have the "answer" scope.',
  }),
  '429': errorResponse('Over 60 requests per minute for this key, or the monthly token quota is used up.', ['rate_limited', 'quota_exceeded'], {
    error: 'rate_limited',
    message: 'Over 60 requests per minute for this key.',
  }),
  '503': errorResponse('A dependency is unavailable. Nothing was served and nothing was charged; retry with backoff.', ['upstream'], {
    error: 'upstream',
    message: 'Usage could not be recorded, so nothing was served. Please retry.',
  }),
};

const DESCRIPTION = `
FairSource serves **licensed, attributed content** from Indian and other non-English publishers to AI applications. Every result is checked against the publisher's licence at request time, and every use is metered and paid to the publisher.

## Authentication

Send your API key as a bearer token:

\`\`\`
Authorization: Bearer fs_<8-character prefix>_<secret>
\`\`\`

Create keys on the **API keys & MCP** page of the FairSource dashboard. A key is shown once; FairSource stores only its hash. Each key has scopes: \`search\`, \`answer\` and \`documents\`.

## What every result carries

- **Attribution:** show \`attribution.text\` wherever you display or use the content, for example *Source: Example Marathi Daily, licensed via FairSource*.
- **Licence tag:** \`attribution.licence\`, such as \`rag/IN+GLOBAL/v3\`: the allowed uses, the territories and the licence version in force.

Content is filtered **before** ranking: articles outside your territory or allowed use, opted out by the publisher, removed from the publisher's site, duplicates or under review are never returned. Results below a minimum relevance are dropped, so you are never charged for unrelated articles.

## Pricing and metering

Each publisher sets a price per 1,000 tokens. A call is charged for the tokens of the licensed content it returns:

\`amountMicros = ceil(tokens / 1000 × pricePer1kTokensMicros)\` per document (USD micros: 1,000,000 = $1).

Every response includes \`usage.tokensServed\` and \`usage.amountMicros\`. If usage cannot be recorded, the API returns 503 and serves nothing. You are billed monthly in arrears from the usage ledger.

## Limits

- 60 requests per minute per key (\`429 rate_limited\`)
- Your plan's monthly token quota (\`429 quota_exceeded\`)

## Use it from an AI agent (MCP)

The same content is available as an MCP tool, \`search_licensed_content\`, over streamable HTTP. Calls are checked and metered exactly like \`/v1/search\` and recorded as \`endpoint = mcp\`.

\`\`\`json
{
  "mcpServers": {
    "fairsource": {
      "type": "http",
      "url": "https://mcp.<domain>/mcp",
      "headers": { "Authorization": "Bearer fs_xxxxxxxx_..." }
    }
  }
}
\`\`\`
`.trim();

export function openApiSpec(opts: OpenApiOptions = {}): Record<string, unknown> {
  const servers = [
    ...(opts.apiBaseUrl ? [{ url: opts.apiBaseUrl, description: 'FairSource API' }] : []),
    { url: 'https://api.{domain}', description: 'FairSource API', variables: { domain: { default: 'fairsource.example', description: 'Your FairSource domain' } } },
    { url: 'http://localhost:8097', description: 'Local demo (API_BACKEND=memory)' },
  ];

  return {
    openapi: '3.1.0',
    info: {
      title: 'FairSource API',
      version: '1.0.0',
      summary: 'Licensed, attributed content for AI, with every use metered and paid to the publisher.',
      description: DESCRIPTION,
      contact: { name: 'FairSource' },
    },
    servers,
    security: [{ apiKey: [] }],
    tags: [
      { name: 'Retrieval', description: 'Find and use licensed content.' },
      { name: 'Account', description: 'Your usage and the service status.' },
    ],
    paths: {
      '/v1/search': {
        post: {
          tags: ['Retrieval'],
          operationId: 'search',
          summary: 'Search licensed content',
          description:
            'Semantic search over licensed chunks in any language: a Hindi query can return Marathi articles. Results are ordered by relevance and each carries its attribution. Needs the `search` scope.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SearchRequest' },
                examples: {
                  hindi: { summary: 'Hindi query, Marathi and Hindi content', value: { query: 'पुणे मेट्रो का नया रूट क्या है?', languages: ['mr', 'hi'], limit: 5, use: 'rag' } },
                  english: { summary: 'English query, any language', value: { query: 'Pune metro line 3 stations', limit: 3 } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Licensed results, most relevant first. May be empty.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SearchResponse' },
                  example: {
                    requestId: 'req_5c2f9a7e-0d1b-4c51-9a3e-8f0e2b6d4a11',
                    results: [
                      {
                        chunkId: '9f2c00000000000000000000000000e1_v1_0',
                        documentId: '9f2c00000000000000000000000000e1',
                        score: 0.83,
                        language: 'mr',
                        text: 'पुणे शहरात नवीन मेट्रो मार्ग\nहिंजवडी ते शिवाजीनगर या नव्या मेट्रो मार्गाचे काम अंतिम टप्प्यात असल्याचे अधिकाऱ्यांनी सांगितले.',
                        attribution: {
                          publisher: 'Example Marathi Daily',
                          title: 'पुणे शहरात नवीन मेट्रो मार्ग',
                          url: 'https://example.in/pune/metro-line-3',
                          publishedAt: '2026-11-17',
                          licence: 'rag/IN+GLOBAL/v3',
                          text: 'Source: Example Marathi Daily, licensed via FairSource',
                        },
                      },
                    ],
                    usage: { tokensServed: 640, amountMicros: 1280 },
                  },
                },
              },
            },
            ...ERRORS,
          },
        },
      },
      '/v1/answer': {
        post: {
          tags: ['Retrieval'],
          operationId: 'answer',
          summary: 'Answer a question from licensed sources',
          description:
            'Retrieves licensed sources and asks Gemini to answer using only them, citing each claim as `[n]`. If no licensed source answers the question, the answer says so and nothing is charged. Every source given to the model is metered. If the model fails, nothing is charged. Needs the `answer` scope.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AnswerRequest' },
                example: { question: 'What is the new Pune metro route?', answerLanguage: 'en', maxSources: 5 },
              },
            },
          },
          responses: {
            '200': {
              description: 'The answer and its numbered citations.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AnswerResponse' },
                  example: {
                    requestId: 'req_8b1e3f2a-6c4d-4e0f-9b7a-2d5c1e8f3a90',
                    answer: 'The new line runs from Hinjewadi to Shivajinagar, and officials say work is in its final stage [1].',
                    citations: [
                      {
                        n: 1,
                        documentId: '9f2c00000000000000000000000000e1',
                        cited: true,
                        attribution: {
                          publisher: 'Example Marathi Daily',
                          title: 'पुणे शहरात नवीन मेट्रो मार्ग',
                          url: 'https://example.in/pune/metro-line-3',
                          publishedAt: '2026-11-17',
                          licence: 'rag/IN+GLOBAL/v3',
                          text: 'Source: Example Marathi Daily, licensed via FairSource',
                        },
                      },
                    ],
                    usage: { tokensServed: 2210, amountMicros: 4420 },
                  },
                },
              },
            },
            ...ERRORS,
          },
        },
      },
      '/v1/documents/{id}': {
        get: {
          tags: ['Retrieval'],
          operationId: 'getDocument',
          summary: 'Get a full licensed document',
          description:
            "The whole cleaned article, metered on its full token count. Returns 404 for any document that isn't licensed to you, without revealing whether it exists. Needs the `documents` scope.",
          parameters: [
            { name: 'id', in: 'path', required: true, description: 'A `documentId` from search or answer results.', schema: { type: 'string' }, example: '9f2c00000000000000000000000000e1' },
            { name: 'use', in: 'query', required: false, description: 'The use you need a licence for.', schema: { type: 'string', enum: ['rag', 'training'], default: 'rag' } },
          ],
          responses: {
            '200': {
              description: 'The document.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/DocumentResponse' } } },
            },
            '404': errorResponse('No licensed document with that ID for this key.', ['not_found'], { error: 'not_found', message: 'No licensed document with that ID.' }),
            ...ERRORS,
          },
        },
      },
      '/v1/usage': {
        get: {
          tags: ['Account'],
          operationId: 'getUsage',
          summary: 'Your usage and spend',
          description: 'Daily tokens, spend and requests for a date range (default: this month so far), and your monthly quota. Live counters; invoices come from the usage ledger. Any valid key works; not rate-limited.',
          parameters: [
            { name: 'from', in: 'query', required: false, description: 'First day, YYYY-MM-DD (India time). Default: the 1st of this month.', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', required: false, description: 'Last day, YYYY-MM-DD. Default: today.', schema: { type: 'string', format: 'date' } },
          ],
          responses: {
            '200': { description: 'Usage for the range.', content: { 'application/json': { schema: { $ref: '#/components/schemas/UsageResponse' } } } },
            '400': ERRORS['400'],
            '401': ERRORS['401'],
          },
        },
      },
      '/v1/health': {
        get: {
          tags: ['Account'],
          operationId: 'health',
          summary: 'Service status',
          description: 'No key needed.',
          security: [],
          responses: {
            '200': {
              description: 'The API is up.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok', 'service', 'schemaVersion'],
                    properties: { ok: { type: 'boolean' }, service: { type: 'string' }, schemaVersion: { type: 'integer' } },
                  },
                  example: { ok: true, service: 'api', schemaVersion: 2 },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'fs_<prefix>_<secret>', description: 'Your FairSource API key, from the dashboard.' },
      },
      schemas: {
        SearchRequest: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 2000, description: 'What to search for, in any language.' },
            languages: { type: 'array', items: ISO_LANG, maxItems: 10, description: 'Only return content in these languages.' },
            limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
            use: { type: 'string', enum: ['rag', 'training'], default: 'rag', description: 'The use you need a licence for.' },
          },
        },
        AnswerRequest: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string', minLength: 1, maxLength: 2000 },
            answerLanguage: { ...ISO_LANG, default: 'en', description: 'Language of the answer, whatever the sources are in.' },
            maxSources: { type: 'integer', minimum: 1, maximum: 8, default: 5 },
            languages: { type: 'array', items: ISO_LANG, maxItems: 10, description: 'Only use sources in these languages.' },
          },
        },
        Attribution: {
          type: 'object',
          required: ['publisher', 'title', 'url', 'publishedAt', 'licence', 'text'],
          properties: {
            publisher: { type: 'string' },
            title: { type: 'string' },
            url: { type: ['string', 'null'], format: 'uri' },
            publishedAt: { type: ['string', 'null'], format: 'date' },
            licence: { type: 'string', description: 'uses/territories/version, e.g. rag/IN+GLOBAL/v3', examples: ['rag/IN+GLOBAL/v3'] },
            text: { type: 'string', description: 'Show this wherever the content is used.' },
          },
        },
        Usage: {
          type: 'object',
          required: ['tokensServed', 'amountMicros'],
          properties: {
            tokensServed: { type: 'integer', description: 'Tokens of licensed content in this response.' },
            amountMicros: { type: 'integer', description: 'Charge in USD micros (1,000,000 = $1).' },
          },
        },
        SearchResult: {
          type: 'object',
          required: ['chunkId', 'documentId', 'score', 'language', 'text', 'attribution'],
          properties: {
            chunkId: { type: 'string', description: '{documentId}_v{version}_{n}' },
            documentId: { type: 'string' },
            score: { type: 'number', minimum: 0, maximum: 1, description: 'Relevance (1 − cosine distance).' },
            language: { type: 'string' },
            text: { type: 'string', description: 'The passage; its first line is the article title.' },
            attribution: { $ref: '#/components/schemas/Attribution' },
          },
        },
        SearchResponse: {
          type: 'object',
          required: ['requestId', 'results', 'usage'],
          properties: {
            requestId: { type: 'string' },
            results: { type: 'array', items: { $ref: '#/components/schemas/SearchResult' } },
            usage: { $ref: '#/components/schemas/Usage' },
          },
        },
        AnswerResponse: {
          type: 'object',
          required: ['requestId', 'answer', 'citations', 'usage'],
          properties: {
            requestId: { type: 'string' },
            answer: { type: 'string', description: 'Cites sources as [n].' },
            citations: {
              type: 'array',
              items: {
                type: 'object',
                required: ['n', 'documentId', 'cited', 'attribution'],
                properties: {
                  n: { type: 'integer' },
                  documentId: { type: 'string' },
                  cited: { type: 'boolean', description: 'Whether the answer text cites [n].' },
                  attribution: { $ref: '#/components/schemas/Attribution' },
                },
              },
            },
            usage: { $ref: '#/components/schemas/Usage' },
          },
        },
        DocumentResponse: {
          type: 'object',
          required: ['requestId', 'document', 'usage'],
          properties: {
            requestId: { type: 'string' },
            document: {
              type: 'object',
              required: ['id', 'title', 'author', 'publishedAt', 'language', 'contentType', 'summary', 'body', 'attribution'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                author: { type: ['string', 'null'] },
                publishedAt: { type: ['string', 'null'], format: 'date-time' },
                language: { type: 'string' },
                contentType: { type: 'string', enum: ['news', 'opinion', 'feature', 'book', 'other'] },
                summary: { type: ['string', 'null'] },
                body: { type: 'string', description: 'Paragraphs separated by blank lines.' },
                attribution: { $ref: '#/components/schemas/Attribution' },
              },
            },
            usage: { $ref: '#/components/schemas/Usage' },
          },
        },
        UsageResponse: {
          type: 'object',
          required: ['from', 'to', 'totals', 'quota', 'days', 'note'],
          properties: {
            from: { type: 'string', format: 'date' },
            to: { type: 'string', format: 'date' },
            totals: {
              type: 'object',
              required: ['tokens', 'spendMicros', 'requests'],
              properties: { tokens: { type: 'integer' }, spendMicros: { type: 'integer' }, requests: { type: 'integer' } },
            },
            quota: {
              type: 'object',
              required: ['monthlyTokens', 'usedThisMonth'],
              properties: { monthlyTokens: { type: 'integer' }, usedThisMonth: { type: 'integer' } },
            },
            days: {
              type: 'array',
              items: {
                type: 'object',
                required: ['date', 'tokens', 'spendMicros', 'requests', 'endpoints', 'languages'],
                properties: {
                  date: { type: 'string', format: 'date' },
                  tokens: { type: 'integer' },
                  spendMicros: { type: 'integer' },
                  requests: { type: 'integer' },
                  endpoints: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Tokens by endpoint: search, answer, document, mcp.' },
                  languages: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Tokens by content language.' },
                },
              },
            },
            note: { type: 'string' },
          },
        },
        ValidationError: {
          type: 'object',
          required: ['error', 'issues'],
          properties: {
            error: { type: 'string', const: 'invalid_request' },
            issues: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
  };
}
