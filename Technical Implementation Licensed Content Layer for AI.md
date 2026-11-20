# Technical Implementation: FairSource, a Licensed Content Layer for AI

Nov 18, 2026 · @Abhishek

## Overview

The system ingests publisher content, makes it AI-ready with Gemini, serves only licensed content to AI buyers through an API and an MCP server, and meters every use so publishers get paid. It is built as five Cloud Run services joined by Pub/Sub, with Firestore as the system of record and BigQuery as the usage ledger, all in asia-south1 (Mumbai).

**Design principles**

- **No manual steps.** Every stage is triggered by an event or a schedule; a human only connects a source and sets a licence.
- **Rights enforced at query time.** Licence fields live on every chunk, so the search query itself excludes anything not licensed to that buyer.
- **Stable identity, idempotent processing.** Each post is keyed by its canonical URL, so an edit updates the same document instead of creating a new one. Its content hash decides whether there is anything new to process, so replaying a message never creates duplicates or double charges.
- **The publisher's site is the source of truth.** New posts, edits and deletions on the site flow through to what buyers are served, with no action from the publisher.
- **Every use is an event.** One API call writes one ledger row; earnings are always recomputable from the ledger.
- **Cheap at rest.** Serverless everywhere, scale to zero, no always-on index endpoint in the MVP.

**Services**

| Service | Responsibility | Trigger |
| --- | --- | --- |
| `ingest` | Fetch RSS/sitemaps, accept uploads, store raw files, emit `content.raw` | Cloud Scheduler, HTTP upload |
| `worker` | OCR, clean, detect language, dedup, chunk, embed, write to Firestore | Pub/Sub push (`content.raw`) |
| `api` | Licensed search and RAG answers, API keys, usage events | HTTPS via API Gateway |
| `mcp` | MCP server exposing licensed search to AI agents | HTTPS (streamable HTTP) |
| `web` | Publisher and buyer dashboards | Firebase App Hosting |

## End-to-end flow

An article is processed once, when it arrives (steps 1–5), and then served many times, each use checked against its licence and logged (steps 6–9). Money flows back to the publisher from the ledger (step 10).

&#91;embedded content: end-to-end flow · 10 steps across 8 components\]

Steps 1–5 take seconds per article and run with no human involved; steps 6–9 happen inside one API request, typically under one second.

## Tech stack and repository layout

TypeScript runs everything users touch; Python runs the AI pipeline, where Akshay's strengths and the Google GenAI SDK are best. One monorepo, one Cloud Build pipeline, one container per service.

| Layer | Choice | Notes |
| --- | --- | --- |
| Languages | TypeScript (Node 22), Python 3.12 | TS: ingest, api, mcp, web. Python: worker |
| AI SDK | Google GenAI SDK (`@google/genai`, `google-genai`) | Same SDK for AI Studio keys (dev) and Vertex AI (prod) |
| Models | Gemini Pro, Gemini Flash, Gemini Flash-Lite, Gemini embedding model, Gemma | Model IDs kept in config, not code, so they can be upgraded |
| API framework | Fastify (TS); Python functions-framework for the worker | The worker only needs one Pub/Sub push handler |
| MCP | `@modelcontextprotocol/sdk`, streamable HTTP transport | Stateless, so it scales on Cloud Run |
| Web | Next.js 15, Tailwind, Firebase Auth | Deployed on Firebase App Hosting |
| Data | Firestore (Native mode), Cloud Storage, BigQuery | Firestore vector search for embeddings |
| Messaging | Pub/Sub with dead-letter topic | Push subscriptions to Cloud Run |
| Payments | Stripe Connect (global), Razorpay Route (India) | Test mode in the MVP |
| CI/CD | GitHub + Cloud Build + Artifact Registry | Build on push to `main`, deploy per service |
| Dev tools | Google AI Studio (prompts), Antigravity (agentic coding) | Prompts exported to `/prompts` and versioned |

```
repo/
├── services/
│   ├── ingest/        # TS: connectors, upload endpoint, publisher of content.raw
│   ├── worker/        # Python: OCR, clean, dedup, chunk, embed
│   ├── api/           # TS: /v1 search, answer, documents, usage
│   └── mcp/           # TS: MCP server wrapping /v1/search
├── web/               # Next.js dashboards
├── packages/shared/   # TS types for Firestore docs and events (single source of truth)
├── prompts/           # Gemini prompts + JSON schemas, versioned
├── infra/             # gcloud setup script, firestore.indexes.json, BigQuery DDL
├── eval/              # golden set: 50 articles with expected outputs
└── cloudbuild.yaml
```

## Ingestion service

The `ingest` service turns any source into raw files in Cloud Storage plus one `content.raw` message per new item. It never processes content itself, so it stays fast and cheap.

**Connectors**

| Connector | How it fetches | New or changed item detection |
| --- | --- | --- |
| RSS / Atom | `GET` feed (with `If-None-Match` / `If-Modified-Since`), parse items, fetch each article URL | Every item in the current feed is re-hashed; a new URL is a new document, a new hash on a known URL is a new version |
| Sitemap | Read `sitemap.xml` (and news sitemaps), follow `<loc>` | `lastmod` newer than the document's `sourceModifiedAt`, or a URL not seen before |
| Upload | Signed URL upload of PDF, image or ZIP from the dashboard | Every distinct file is new; ZIPs are expanded |
| CMS API (later) | WordPress REST `/wp-json/wp/v2/posts`, Ghost Content API and webhooks | `modified_gmt` cursor; `post.published`, `post.edited`, `post.deleted` |

**Document identity.** Ingest is the only service that creates document IDs, using `docIdFor()` in `packages/shared/src/schema.ts`:

- Web content: `docId = sha256("url:" + canonicalUrl)`, first 32 hex characters. The canonical URL comes from the page's `<link rel="canonical">` when it points at the same host. Otherwise it is the item URL, normalised: `https`, lowercase host without `www.`, no fragment, tracking parameters (`utm_*`, `fbclid`, …) removed, no trailing slash.
- RSS items with no link: `sha256("guid:" + sourceId + ":" + guid)`.
- Uploads: `sha256("upload:" + contentHash)`.

Because RSS and the sitemap give the same URL, a post found by both becomes one document, listed in `sourceIds[]`.

**Flow for one source run**

1. Cloud Scheduler calls `POST /internal/run-due` every 5 minutes (OIDC-authenticated, service account only). A source runs when its `scheduleMins` (30) have passed, when "Sync now" set `sources.syncRequestedAt`, or while its backfill is unfinished. A lease (`sources.leaseUntil`) stops two runs overlapping.
2. The service loads the source, checks `robots.txt`, then fetches the feed or sitemap (with `If-None-Match` / `If-Modified-Since` on scheduled runs).
3. For each item it computes `docId` and `contentHash = sha256(article text)`. The text is the `<article>`, `<main>` or `<body>` with navigation, header, footer, sidebars and scripts removed, so a new ad is not an edit. Pages with almost no text, and all files, hash their bytes.
4. If the hash equals the document's `contentHash` or `pendingContentHash`, nothing is sent; only `lastSeenAt` and `sourceIds` are updated.
5. Otherwise it writes the raw file to `gs://<bucket>-raw/{publisherId}/{yyyy}/{mm}/{contentHash}.{ext}` with `ifGenerationMatch=0`, creates the document stub if the post is new (version 0, status `queued`), publishes `content.raw`, and only then sets `pendingContentHash`, so a failed publish is retried on the next run. An edited document keeps serving its current version until the worker swaps it in. The decision uses the document's hashes, not whether the raw file exists, so an edit that is reverted (A → B → A) is still sent.

Backfill saves its position (`backfill.cursor`: the next feed page, or the index in the sorted sitemap URL list) after each page or every 25 URLs, and stops after `RUN_BUDGET_MS` (4 minutes), so a large blog is imported across several 5-minute runs without repeating work.

Code: `services/ingest/src/` (`sync.ts` runs, `items.ts` per-item logic, `sweep.ts` deletions, `uploads.ts`, `discover.ts`). Tests: `src/test/` run against a fake website and the in-memory backend.

**`content.raw` message contract (v2)**

```json
{
  "schemaVersion": 2,
  "docId": "6fdcdf13dab4fd7a4bb858edd6684fd2",
  "identityKey": "url:https://example.in/article/1",
  "contentHash": "<sha256>",
  "publisherId": "pub_123",
  "sourceId": "src_456",
  "rawUri": "gs://fs-raw/pub_123/2026/11/<contentHash>.html",
  "mimeType": "text/html",
  "sourceUrl": "https://example.in/article/1",
  "sourceModifiedAt": "2026-11-20T09:58:00Z",
  "reason": "changed",
  "fetchedAt": "2026-11-20T10:15:00Z"
}
```

Message attributes carry `publisherId` and `mimeType` so subscriptions can filter later (for example, a separate OCR subscription for PDFs).

**Limits:** one fetch at a time per domain, 1 request per second, a `User-Agent` naming the product, and a 10 MB cap per file in the MVP.

## Keeping sources in sync

FairSource stores its own copy of every article, both raw and cleaned, so it can serve fast, OCR scans and prove what each buyer was served. This means the copy has to follow the publisher's site.

| Change on the publisher's site | How we detect it | What happens |
| --- | --- | --- |
| Blog connected for the first time | `sources.backfill.status = pending` | Backfill reads the full sitemap, or pages back through the feed (WordPress `?paged=N`), and queues every post with `reason = backfill`. Progress is shown on the Sources page and can resume from `backfill.cursor`. |
| New post | Next 30-minute run, or "Sync now" | New `docId`, version 1 |
| Edited post | New `contentHash` on a known `docId` | `version + 1`; the worker replaces the old chunks in one batch and records the old version in `documents/{docId}/versions/{n}` |
| Deleted post | Daily sweep: URLs missing from the sitemap, plus documents with `lastCheckedAt` older than 7 days, get an HTTP `HEAD`; 404 or 410 means deleted | `status = withdrawn`, `servable = false`, removed from search within seconds; ledger rows kept |
| Publisher removes it in the dashboard | Opt-out toggle or delete | Same as above, with `withdrawnReason = publisher_removed` |

A feed shows only recent items, so a post missing from the feed is never taken as deleted. Only the sitemap diff and the HTTP check can withdraw a post. A timeout or a 5xx response is retried on the next sweep and never withdraws anything.

**Discovering the feed.** If a publisher pastes only the site URL, ingest looks in order for `<link rel="alternate" type="application/rss+xml">`, then `/feed` and `/rss`, then `/sitemap.xml` and the `Sitemap:` lines in `robots.txt`. It saves the method it used in `sources.discoveredFrom`.

**After the MVP:** WordPress plugin or REST API with a `modified_gmt` cursor, Ghost webhooks, and WebSub, so changes arrive in seconds instead of within 30 minutes.

## Processing pipeline

The `worker` turns one `content.raw` message into a clean document plus embedded, rights-tagged chunks in a single idempotent pass. It returns HTTP 2xx only after everything is written, so Pub/Sub retries anything that fails part-way.

**Steps for one item**

1. **Skip work already done:** ack and stop if the document is withdrawn, if its `contentHash` equals the message's and `status == "done"`, or if `processedFetchedAt` is later than the message's `fetchedAt` (an older fetch arriving late). A missing stub returns 503 so Pub/Sub retries. Otherwise this is a new document (version 1) or an edit (version + 1).
2. **Load** the raw file from Cloud Storage.
3. **Extract text.** HTML: main-content extraction with `trafilatura` (plus its title, author and date as hints). PDF or image: Gemini Pro OCR with the file sent inline. PDFs are split into 10-page parts with `pypdf` and OCR'd part by part, but stay **one document** (up to 300 pages). Fewer than 40 characters of text is a permanent failure (`no_text`).
4. **Clean and structure:** Gemini Flash with the response schema (below) and the extraction hints. If the cleaned title and body hash (`cleanHash`) equal the current version's, only the page around the article changed: record the new `contentHash` and stop, without re-embedding.
5. **Language cross-check:** a local check must not contradict Gemini. It checks the script (Devanagari vs Latin, from Unicode ranges); for Devanagari, Marathi vs Hindi marker words (आहे, आणि, च्या… vs है, और, के…) and the letter ळ; for English, common function words. It has no opinion on other languages. A contradiction sets `needsReview = true`. fastText `lid.176` can replace it later behind the same function (`worker/textutil.py`).
6. **Near-duplicate check:** a 64-bit SimHash of the body over word 3-shingles, stored as four 16-bit band fields. Candidates are the **same publisher's** processed documents sharing a band, within 8 bits. Gemma is asked whether the closest 3 are the *same article* (republished, AMP, print), not merely the same event. Only a different `docId` can be a duplicate; an earlier version of the same URL never is. Duplicates get `duplicateOf` and are not served twice.
7. **Safety filter:** 10 or more phone numbers and email addresses mark the item `pii_heavy` without a model call. Otherwise Gemma labels it `ok`, `adult`, `hate` or `pii_heavy`. Anything but `ok` is stored with `servable = false`; an unreadable label sets `needsReview`.
8. **Chunk:** paragraphs grouped into chunks of 400–600 tokens with a 60-token overlap; over-long paragraphs are split at sentence ends (`.`, `?`, `!`, `।`) and then at words. Each chunk starts with the title. Sizes use an estimate (about 4 characters per token for ASCII text, about 2.5 for other scripts); the stored `tokenCount`, which metering uses, comes from Gemini `count_tokens` when available.
9. **Embed:** Gemini embedding model, `task_type = RETRIEVAL_DOCUMENT`, `output_dimensionality = 768`, the title passed as `title`, batches of 100 (falling back to one per request if the endpoint refuses batches), vectors re-normalised.
10. **Write:** the clean JSON goes to `gs://<bucket>-clean/{publisherId}/{docId}/v{version}-{hash}.json`. Then one Firestore transaction re-reads the document, re-checks steps 1's conditions and that `version` is unchanged, and writes everything together: new chunks `{docId}_v{version}_{n}`, deleting the document's other chunks, the document fields, `versions/{version}`, and `supersededAt` on the previous version. `servable` and the chunks' `optOut` are computed inside the transaction from the current `optOut`, so a publisher's opt-out made during processing is never overwritten. Rights fields come from the publisher's active licence. `pendingContentHash` is cleared only if it still equals this message's hash. Then `content.processed` is published with `replacedChunkCount`. Documents too large for one commit (over 450 writes) are written in phases: new chunks hidden, the document switched transactionally, old chunks deleted, new ones shown.

Code: `services/worker/src/worker/` (`pipeline.py` steps, `ai.py` Gemini/Gemma, `textutil.py` language/SimHash/chunker, `extract.py`, `gcp.py`, `main.py`). Tests: `services/worker/tests/`. Try it with a real key: `scripts/try_gemini.py <url or file>`.

**Model use per step**

| Step | Model | Why this model |
| --- | --- | --- |
| OCR of scans | Gemini Pro | Best accuracy on Devanagari and complex layouts |
| Clean and structure | Gemini Flash | Fast, cheap, reliable structured output |
| Duplicate confirmation, safety label | Gemma (instruction-tuned, via Gemini API) | Very cheap yes/no and label tasks at high volume |
| Embeddings | Gemini embedding model | Multilingual, so cross-language search works |
| RAG answer (in `api`) | Gemini Flash | Low latency for buyers |

**Clean-and-structure response schema** (`prompts/clean.v1.json`)

```json
{
  "type": "object",
  "properties": {
    "title": {"type": "string"},
    "author": {"type": "string", "nullable": true},
    "publishedAt": {"type": "string", "description": "ISO 8601 or null", "nullable": true},
    "language": {"type": "string", "description": "ISO 639-1, e.g. mr, hi, en"},
    "script": {"type": "string", "description": "ISO 15924, e.g. Deva, Latn"},
    "body": {"type": "string", "description": "Article text only, paragraphs separated by blank lines"},
    "summary": {"type": "string", "description": "2 sentences, same language as body"},
    "topics": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
    "contentType": {"type": "string", "enum": ["news", "opinion", "feature", "book", "other"]},
    "qualityScore": {"type": "number", "description": "0 to 1"}
  },
  "required": ["title", "language", "script", "body", "contentType", "qualityScore"]
}
```

**Prompt (system instruction, abridged):** “You receive raw text extracted from a publisher's web page or scan. Return only the article itself. Do not translate, summarise inside `body`, or add facts. Keep the original language and spelling. If the page has no article, return `contentType: other` and `qualityScore: 0`.”

**Failure handling**

| Failure | Behaviour |
| --- | --- |
| Gemini 429, 408 or 5xx, or a network error | Backoff inside the request (2 s, 4 s; 3 tries), then HTTP 503 so Pub/Sub retries |
| Other Gemini 4xx (e.g. a file the model rejects) | Permanent: document marked failed, message acknowledged |
| Invalid JSON from the model | One retry with the validation error appended to the prompt; then permanent failure |
| Permanent failure on a **new** document | `status = failed`, `servable = false`, `processingError` set, HTTP 200 |
| Permanent failure on an **edit** | The current version stays live; only `processingError` is set. `pendingContentHash` stays, so ingest doesn't resend the same broken content |
| Malformed message (bad envelope or schema) | HTTP 204: acknowledged and logged. Push subscriptions treat every non-2xx as "retry", so 400 would only bounce it to the dead-letter topic |
| Unexpected exception (a bug) | HTTP 500 with the stack trace logged; retried, then dead-lettered |
| 5 failed deliveries | Pub/Sub moves the message to `content.raw.dlq`; a daily job re-queues it once |
| PDF over 300 pages, encrypted or unreadable | Permanent failure with a reason code (`pdf_too_long`, `pdf_encrypted`, `pdf_unreadable`) |

**Gemma on Vertex AI:** Gemma is served by the Gemini API, not by Vertex AI's Gemini endpoint. In production (`GOOGLE_GENAI_USE_VERTEXAI=true`), set `GEMMA_API_KEY` from Secret Manager; without it, the dedup and safety checks run on Gemini Flash.

Cloud Run settings for `worker`: request timeout 600 s, concurrency 4, max instances 20, 2 vCPU / 2 GiB memory.

## Data model

Firestore holds everything the product reads per request; BigQuery holds the append-only usage ledger. TypeScript types for every document live in `packages/shared/src/schema.ts` (schema version 2), and the Python worker mirrors them in `services/worker/src/worker/models.py`.

**Firestore collections**

| Collection | Document ID | Fields |
| --- | --- | --- |
| `publishers` | `pub_*` | name, country, languages\[\], ownerUid, revenueSharePct (default 75), payout { provider, accountRef }, status |
| `sources` | `src_*` | publisherId, type (rss, sitemap, upload, cms), name, url, discoveredFrom, consentAt, scheduleMins, status, lastError, lastFetchedAt, lastFullSyncAt, etag, lastModifiedHeader, backfill { status, discovered, queued, cursor }, syncRequestedAt, itemCount |
| `licences` | `lic_*` | publisherId, uses\[\] (rag, training), territories\[\] (IN, GLOBAL), pricePer1kTokensMicros, active, version |
| `documents` | `sha256(identityKey)`, 32 hex | identityKey, canonicalUrl, sourceUrl, guid, publisherId, sourceId, sourceIds\[\], version, contentHash, pendingContentHash, title, author, publishedAt, sourceModifiedAt, language, script, topics\[\], summary, contentType, qualityScore, chunkCount, tokenCount, simhash, band0–band3, duplicateOf, needsReview, safety, optOut, servable, status (queued, processing, done, failed, withdrawn), licenceId, rawUri, cleanUri, firstSeenAt, lastSeenAt, lastCheckedAt, lastHttpStatus, processedAt, withdrawnAt, withdrawnReason |
| `documents/{id}/versions` | version number | contentHash, rawUri, cleanUri, chunkCount, tokenCount, licenceId, processedAt, supersededAt |
| `chunks` | `{docId}_v{version}_{n}` | documentId, documentVersion, n, publisherId, text, tokenCount, embedding (vector 768), language, servable, optOut, uses\[\], territories\[\], licenceId, licenceVersion |
| `buyers` | `buy_*` | name, ownerUid, country, plan, monthlyQuotaTokens, status |
| `apiKeys` | key prefix | buyerId, hash (SHA-256), scopes\[\], createdAt, revokedAt |
| `earnings` | `{pubId}_{yyyymmdd}` | publisherId, date, tokensServed, grossMicros, publisherShareMicros |

**Vector index on `chunks`**

```bash
gcloud firestore indexes composite create \
  --collection-group=chunks --query-scope=COLLECTION \
  --field-config=order=ASCENDING,field-path=servable \
  --field-config=order=ASCENDING,field-path=optOut \
  --field-config=field-path=embedding,vector-config='{"dimension":"768","flat":"{}"}'
```

The nearest-neighbour query pre-filters on `servable == true` and `optOut == false`, uses cosine distance, and over-fetches 50 candidates so the licence and territory check (next section) can drop rows and still return the requested `limit`.

**BigQuery dataset `ledger`**

```sql
CREATE TABLE ledger.usage_events (
  event_id STRING NOT NULL,        -- UUID from the api service; dedup key
  ts TIMESTAMP NOT NULL,
  buyer_id STRING NOT NULL,
  api_key_prefix STRING,
  endpoint STRING,                 -- search | answer | document | mcp
  publisher_id STRING NOT NULL,
  document_id STRING NOT NULL,
  document_version INT64,          -- version of the document at time of use
  chunk_ids ARRAY<STRING>,         -- {docId}_v{version}_{n}
  licence_id STRING,
  licence_version INT64,
  tokens_served INT64,
  amount_micros INT64,             -- price at time of use, in USD micros
  request_id STRING
)
PARTITION BY DATE(ts)
CLUSTER BY publisher_id, buyer_id;
```

One API call that returns chunks from three publishers writes three rows, one per publisher, so payouts never need to split a row.

## Rights and licence enforcement

A chunk is returned to a buyer only if all five checks pass, and the checks run inside the `api` service on every request, never in the client. The same function is used by search, answer, document and MCP calls.

```ts
// services/api/src/rights.ts
export function isServable(chunk: Chunk, buyer: Buyer, use: 'rag' | 'training'): boolean {
  if (!chunk.servable || chunk.optOut) return false;           // safety, dedup, publisher opt-out
  if (!chunk.uses.includes(use)) return false;                 // licence allows this kind of use
  const t = chunk.territories;
  if (!(t.includes('GLOBAL') || t.includes(buyer.country))) return false; // territory
  if (buyer.status !== 'active') return false;                 // buyer in good standing
  return true;
}
```

**Keeping rights fields current**

- Rights fields are copied onto chunks at write time so search can filter without joins.
- A Firestore-triggered function (Eventarc, `documents` or `licences` updated) re-stamps every affected chunk within seconds when a publisher opts out, changes territories or deactivates a licence. Large publishers are re-stamped in pages of 500 writes.
- Each usage row stores `licence_id` and `licence_version`, so the terms in force at the time of use can always be proven.

**Attribution returned with every chunk**

```json
"attribution": {
  "publisher": "Example Marathi Daily",
  "title": "पुणे शहरात नवीन मेट्रो मार्ग",
  "url": "https://example.in/article/1",
  "publishedAt": "2026-11-19",
  "licence": "rag/IN+GLOBAL/v3",
  "text": "Source: Example Marathi Daily, licensed via FairSource"
}
```

Buyers agree in the API terms to show `attribution.text` wherever content is displayed; RAG answers from `/v1/answer` include it automatically.

## Licensed API

The `api` service is a versioned REST API (`/v1`) on Cloud Run behind a global external Application Load Balancer (serverless NEG). Every successful call emits usage events before the response is returned, so nothing is served without being metered.

**Authentication**

- Header: `Authorization: Bearer fs_<prefix>_<secret>`. The 8-character prefix finds the `apiKeys` doc; the SHA-256 of the full key must match `hash`.
- Keys are created in the buyer dashboard and shown once. Revoking sets `revokedAt`; the key fails within 60 seconds (cache TTL).

**Endpoints**

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/search` | Semantic search over licensed chunks |
| POST | `/v1/answer` | RAG answer by Gemini Flash using only licensed chunks, with citations |
| GET | `/v1/documents/{id}` | Full licensed document (metered on its full token count) |
| GET | `/v1/usage?from=&to=` | The buyer's own usage and spend |
| GET | `/v1/health` | Liveness, no auth |

**`POST /v1/search`**

```json
// request
{ "query": "पुणे मेट्रो का नया रूट", "languages": ["mr", "hi"], "limit": 5, "use": "rag" }

// response 200
{
  "requestId": "req_01J...",
  "results": [
    {
      "chunkId": "9f2c..._3",
      "documentId": "9f2c...",
      "score": 0.83,
      "language": "mr",
      "text": "...",
      "attribution": { "publisher": "...", "title": "...", "url": "...", "licence": "rag/IN+GLOBAL/v3", "text": "..." }
    }
  ],
  "usage": { "tokensServed": 1840, "amountMicros": 3680 }
}
```

Internally: embed the query (`task_type = RETRIEVAL_QUERY`, 768 dimensions, same model as the worker) → Firestore `findNearest` (cosine, 50 candidates, pre-filtered on the chunk's `servable` and `optOut`) → drop results below `MIN_SCORE` relevance (default 0.35, `score = 1 − cosine distance`) → optional language filter → **live rights check** → top `limit` → ledger rows → response.

**Live rights check.** Each surviving chunk is checked against its document and the publisher's licence as they are now: document `status = done`, not opted out, not a duplicate, not under review, safety `ok`, and the chunk's `documentVersion` equal to the document's `version`; the publisher's active licence allows the use and the buyer's territory. Licences are cached for 30 seconds. So an opt-out or a withdrawal takes effect on the very next request, and a licence change within 30 seconds, even before chunks are re-stamped. `POST /internal/restamp` (`{documentId}` or `{publisherId}`, `x-internal-token` header) re-stamps chunk fields so the vector pre-filter matches again; the web app calls it after an opt-out toggle or a licence save, which is what makes an article that is opted back in reappear.

**Minimum relevance.** Without a floor, nearest-neighbour search always returns something, so an unrelated query would return, and charge for, unrelated articles. 0.35 is a starting point; calibrate it with the retrieval evaluation set once real embeddings exist.

**`POST /v1/answer`**

```json
// request
{ "question": "What is the new Pune metro route?", "answerLanguage": "en", "maxSources": 5 }

// response 200
{
  "answer": "The new line runs from ... [1] ... [2]",
  "citations": [ { "n": 1, "documentId": "...", "attribution": { ... } } ],
  "usage": { "tokensServed": 2210, "amountMicros": 4420 }
}
```

The answer prompt tells Gemini to use only the supplied chunks, cite each claim as `[n]`, and say it does not know when the chunks do not answer the question.

**Metering on each call:** one ledger row per **document** served (a row has one `document_id` and `document_version`), with `amount_micros = ceil(tokens / 1000 × pricePer1kTokensMicros)` at the publisher's licence price. Rows go to the `usage.events` topic as snake_case JSON matching the table, and its BigQuery subscription writes them into `ledger.usage_events`. If publishing fails, the API returns 503 and serves nothing. After that, best effort (the ledger stays the record of money): `earnings/{pubId}_{yyyymmdd}` and `buyerUsage/{buyerId}_{yyyy-mm-dd}` counters are incremented, and `buyers.usedTokensThisMonth` (reset when `usageMonth` changes). Counter dates use India time (`Asia/Kolkata`). `/v1/answer` meters every source given to the model, and charges nothing if the model fails; `/v1/documents/{id}` meters the document's `tokenCount`. Calls from the MCP server send `x-fairsource-client: mcp` and are recorded with `endpoint = mcp`.

**Keys and limits in code:** `services/api/src/auth.ts` (key cache 60 s, buyer cache 10 s, 60 requests per minute per key per instance, monthly quota), `rights.ts`, `service.ts`, `meter.ts`. Run locally without Google Cloud: `API_BACKEND=memory npm run dev -w services/api` seeds the mockup's publishers, articles and a demo key (printed in the log).

**Limits and errors**

| Code | When |
| --- | --- |
| 400 `invalid_request` | Schema validation failed (zod) |
| 401 `invalid_key` | Missing, wrong or revoked key |
| 403 `licence_scope` | Buyer asked for a use or territory it does not hold |
| 404 `not_found` | Document missing or not servable to this buyer (never reveals which) |
| 429 `rate_limited` | Over 60 requests per minute per key, or monthly token quota used |
| 503 `upstream` | Gemini or Firestore unavailable after retries |

A Cloud Armor policy on the load balancer adds a per-IP rate rule (600 requests per minute) and blocks known-bad traffic before it reaches Cloud Run. The per-key limit of 60 requests per minute is enforced in the service.

## MCP server

The `mcp` service lets any MCP-capable agent (Gemini, Claude CLI, custom agents) search licensed content as a tool, with the same rights checks and metering as the REST API. It is a thin wrapper: it never reads Firestore itself, it calls `api` with the buyer's key.

| Setting | Value |
| --- | --- |
| Endpoint | `https://mcp.<domain>/mcp` |
| Transport | Streamable HTTP, stateless (no session affinity needed on Cloud Run) |
| Auth | `Authorization: Bearer <buyer API key>`, passed through to `api` |
| SDK | `@modelcontextprotocol/sdk` (TypeScript) |
| Metering | Events tagged `endpoint = "mcp"` |

**Tools**

```json
{
  "name": "search_licensed_content",
  "description": "Search licensed, attributed news and articles in Indian and other non-English languages. Always show the attribution text when using results.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query in any language" },
      "languages": { "type": "array", "items": { "type": "string" }, "description": "ISO 639-1 codes, e.g. mr, hi" },
      "limit": { "type": "integer", "minimum": 1, "maximum": 10, "default": 5 }
    },
    "required": ["query"]
  }
}
```

Implemented in `services/mcp/src/` (stateless: a new server and transport per request; JSON responses; GET and DELETE return 405). A missing key is refused with 401 at connect time; a wrong or revoked key is returned as a tool error the agent can show. A second tool, `get_licensed_document(documentId)`, is added after the MVP. Tool results return each chunk as text with its attribution line appended, so the agent's answer carries the citation naturally.

**Client config used in the demo**

```json
{ "mcpServers": { "fairsource": { "type": "http", "url": "https://mcp.<domain>/mcp", "headers": { "Authorization": "Bearer fs_xxxxxxxx_..." } } } }
```

## Metering, earnings and payouts

The BigQuery ledger is the source of truth for money; Firestore counters only drive the live dashboard. Payouts are always computed from the ledger, so a bug in a counter can never change what a publisher is paid.

**Two paths from one API call**

| Path | Write | Used for | Latency |
| --- | --- | --- | --- |
| Live counter | `FieldValue.increment` on `earnings/{pubId}_{date}` | Earnings counter in the dashboard (demo moment) | Under 1 s |
| Ledger | Pub/Sub `usage.events` → BigQuery subscription → `ledger.usage_events` | Statements, payouts, audits, buyer invoices | Seconds |

Pub/Sub delivers at least once, so every ledger query de-duplicates on `event_id`.

**Daily earnings (scheduled query, every hour)**

```sql
MERGE ledger.earnings_daily T
USING (
  SELECT publisher_id, DATE(ts, 'Asia/Kolkata') AS day,  -- same day boundary as the live counters
         SUM(tokens_served) AS tokens,
         SUM(amount_micros) AS gross_micros
  FROM (
    SELECT * FROM ledger.usage_events
    WHERE DATE(ts) >= DATE_SUB(CURRENT_DATE(), INTERVAL 2 DAY)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY ts) = 1
  )
  GROUP BY publisher_id, day
) S
ON T.publisher_id = S.publisher_id AND T.day = S.day
WHEN MATCHED THEN UPDATE SET tokens = S.tokens, gross_micros = S.gross_micros
WHEN NOT MATCHED THEN INSERT (publisher_id, day, tokens, gross_micros)
  VALUES (S.publisher_id, S.day, S.tokens, S.gross_micros);
```

The publisher's share is applied at payout time (`gross × revenueSharePct`), so a change to the share never rewrites history.

**Monthly payout job** (Cloud Run job, triggered on the 3rd of each month)

1. Sum last month's `earnings_daily` per publisher; apply the revenue share.
2. Skip balances under USD 10 (carried forward).
3. Create a `payouts/{pubId}_{yyyymm}` doc with status `pending` (idempotency key).
4. Transfer: Stripe Connect transfer for global publishers, Razorpay Route transfer for Indian ones (both in test mode in the MVP).
5. Generate a PDF statement (per document: uses, tokens, amount) to Cloud Storage and email the link.
6. Mark the payout `paid` with the provider's transfer ID.

Buyers are billed monthly in arrears from the same ledger through Stripe Billing usage records.

## Dashboards

One Next.js app serves both publishers and buyers; the role on the signed-in user decides which pages they see. All reads and writes go through server actions using the Firebase Admin SDK, and Firestore security rules deny all direct client writes; the only direct client reads allowed are a user's own `earnings` and usage counter documents, for live listeners.

**Publisher pages**

| Page | What it does |
| --- | --- |
| Onboarding | Name, country, languages, payout account (Stripe Connect / Razorpay onboarding link), consent checkbox |
| Sources | Add RSS or sitemap URL, upload PDFs or ZIPs (signed URL straight to Cloud Storage), see last run and item counts |
| Licence | Toggle uses (RAG, training), territories (India, global), price per 1,000 tokens; each save creates a new licence version |
| Content | Searchable list of documents with language, status, safety label, opt-out toggle per document |
| Earnings | Live counter (Firestore listener), daily chart from `earnings_daily`, top documents by use, statements |

**Buyer pages**

| Page | What it does |
| --- | --- |
| API keys | Create (shown once), name, revoke |
| Playground | Try `/v1/search` and `/v1/answer` in the browser with the buyer's key |
| Usage | Tokens and spend by day, endpoint and language |
| Billing | Plan, quota, invoices (Stripe Billing customer portal) |
| MCP setup | Copy-paste client config with the endpoint and key placeholder |

**Auth:** Firebase Auth with Google sign-in; the ID token is exchanged for an httpOnly `__session` cookie (5 days) carrying custom claims `role = publisher | buyer` and `orgId`, verified on every page and server action. `infra/create-org.ts` creates an organisation and sets the claims. All reads and writes go through server actions with the Admin SDK; Firestore rules deny all client access. Without `DATA_BACKEND=firestore` the app runs on built-in demo data with no sign-in. An `admin` view (failed items, dead-letter queue, payouts) comes later.

## Security, IAM and compliance

Each service runs as its own service account with only the roles it needs, and no service account keys exist anywhere; everything authenticates with Workload Identity. Secrets live only in Secret Manager.

| Service account | Roles |
| --- | --- |
| `sa-ingest` | Storage Object Creator (raw bucket), Pub/Sub Publisher (`content.raw`), Datastore User |
| `sa-worker` | Storage Object Viewer (raw), Storage Object Creator (clean), Vertex AI User, Datastore User, Pub/Sub Publisher (`content.processed`) |
| `sa-api` | Datastore User, Vertex AI User, Pub/Sub Publisher (`usage.events`), Secret Manager Secret Accessor |
| `sa-mcp` | None: it calls the public `api` with the buyer's own key |
| `sa-jobs` | BigQuery Data Editor and Job User (`ledger`), Datastore User, Secret Manager Secret Accessor (payment keys) |
| `sa-scheduler` | Cloud Run Invoker on `ingest` internal routes |

**Controls**

- **Network:** only `api`, `mcp` and `web` accept public traffic; `ingest` internal routes and `worker` require OIDC tokens from Scheduler or Pub/Sub.
- **Edge:** Cloud Armor (rate limits, OWASP preconfigured rules) on the load balancer.
- **Secrets:** Stripe, Razorpay and Gemini API keys in Secret Manager, mounted as env vars at deploy time, rotated every 90 days.
- **API keys:** stored only as SHA-256 hashes; shown once at creation.
- **Data residency:** all buckets, Firestore, BigQuery and Vertex AI calls pinned to asia-south1 for Indian publishers.
- **Audit:** Cloud Audit Logs for admin and data access; the ledger records licence version for every use.
- **Publisher rights:** consent timestamp per source; opt-out takes effect on the next request (rights re-stamp within seconds).

**Compliance notes**

- India's Digital Personal Data Protection Act applies to account data (publisher and buyer users). Collect the minimum, publish a privacy notice, and support deletion requests.
- Article content can contain personal data; the `pii_heavy` safety label keeps such items unserved until reviewed.
- Payment card and bank data never touch our systems: Stripe and Razorpay hosted onboarding handle them.

## Infrastructure and deployment

Two projects, `lcl-dev` and `lcl-prod`, are created from one script in `infra/setup.sh`; every service deploys from `main` through Cloud Build. For the buildathon, only `lcl-dev` is needed.

**One-time setup (abridged from `infra/setup.sh`)**

```bash
PROJECT=lcl-dev; REGION=asia-south1
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com pubsub.googleapis.com firestore.googleapis.com \
  storage.googleapis.com bigquery.googleapis.com aiplatform.googleapis.com \
  cloudscheduler.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com eventarc.googleapis.com

gcloud firestore databases create --location=$REGION
gcloud storage buckets create gs://$PROJECT-raw gs://$PROJECT-clean --location=$REGION \
  --uniform-bucket-level-access
bq --location=$REGION mk --dataset $PROJECT:ledger
bq query --use_legacy_sql=false < infra/ledger.sql

gcloud pubsub topics create content.raw content.raw.dlq content.processed usage.events
gcloud pubsub subscriptions create usage-to-bq --topic=usage.events \
  --bigquery-table=$PROJECT:ledger.usage_events --use-table-schema
gcloud artifacts repositories create services --repository-format=docker --location=$REGION
```

**Wiring after the first deploy**

```bash
# worker: Pub/Sub push with retries and dead-letter
gcloud pubsub subscriptions create content-raw-worker --topic=content.raw \
  --push-endpoint=$WORKER_URL/pubsub --push-auth-service-account=sa-pubsub@$PROJECT.iam.gserviceaccount.com \
  --ack-deadline=600 --min-retry-delay=10s --max-retry-delay=600s \
  --dead-letter-topic=content.raw.dlq --max-delivery-attempts=5

# ingest: check every 5 minutes; each source runs when due (every 30 minutes) or while backfilling
gcloud scheduler jobs create http run-sources --location=$REGION --schedule="*/5 * * * *" \
  --uri=$INGEST_URL/internal/run-due --http-method=POST --attempt-deadline=300s \
  --oidc-service-account-email=sa-scheduler@$PROJECT.iam.gserviceaccount.com

# ingest: daily deletion sweep (03:00 IST)
gcloud scheduler jobs create http sweep-sources --location=$REGION --schedule="30 21 * * *" \
  --uri=$INGEST_URL/internal/sweep --http-method=POST --attempt-deadline=300s \
  --oidc-service-account-email=sa-scheduler@$PROJECT.iam.gserviceaccount.com

# ingest: process each finished upload (objects under uploads/ in the raw bucket)
gcloud eventarc triggers create upload-finalized --location=$REGION \
  --destination-run-service=ingest --destination-run-path=/internal/upload-finalized \
  --event-filters=type=google.cloud.storage.object.v1.finalized --event-filters=bucket=$PROJECT-raw \
  --service-account=sa-scheduler@$PROJECT.iam.gserviceaccount.com
```

Deploy `ingest` with `--timeout=300` and `--ingress=internal-and-cloud-load-balancing`. The web app's service account also needs `roles/run.invoker` on `ingest`, for Sync now (`/internal/run`), feed discovery (`/internal/discover`) and upload URLs (`/uploads/sign`).

**Cloud Build (`cloudbuild.yaml`, per service)**

1. Install, lint, unit test (`pnpm test` / `pytest`).
2. Build the container with Docker and push to Artifact Registry, tagged with the commit SHA.
3. `gcloud run deploy <service> --image=... --region=asia-south1 --service-account=sa-<service> --set-secrets=...`.
4. Run the smoke test (`/v1/health`, one search against the golden set).

| Service | Min / max instances | Concurrency | CPU / memory | Ingress |
| --- | --- | --- | --- | --- |
| ingest | 0 / 5 | 10 | 1 / 512 MiB | internal + load balancer (uploads) |
| worker | 0 / 20 | 4 | 2 / 2 GiB | internal |
| api | 1 / 20 | 40 | 1 / 1 GiB | load balancer |
| mcp | 0 / 10 | 40 | 1 / 512 MiB | load balancer |

`api` keeps one warm instance so the demo's first query is fast. The web app deploys separately through Firebase App Hosting from the same repo.

## Observability, testing and scaling path

Every request and pipeline step logs one structured JSON line with `requestId` or `itemId`, so a single article or API call can be traced across services in Cloud Logging.

**Monitoring and alerts (Cloud Monitoring)**

| Signal | Alert when |
| --- | --- |
| `content.raw` oldest unacked message age | Over 15 minutes |
| Dead-letter topic message count | Any message |
| `api` p95 latency (`/v1/search`) | Over 1.5 s for 10 minutes |
| `api` 5xx rate | Over 1% for 5 minutes |
| Gemini error rate (log-based metric) | Over 5% for 10 minutes |
| Ledger vs counter drift (daily check) | Over 0.5% for any publisher |
| Billing budget | 50%, 90%, 100% of monthly budget |

**Testing**

- **Unit:** rights function (every combination of use, territory, opt-out), pricing maths, chunker, schema validation.
- **Prompt evaluation:** `eval/` holds 50 golden articles (Marathi, Hindi, English, 10 scans) with expected title, language and body. CI fails if field accuracy drops below 95% or OCR character error rate rises above 5% after a prompt or model change.
- **Retrieval evaluation:** 30 queries with known correct documents, including Hindi-query-to-Marathi-article pairs; track recall at 5.
- **Integration:** Firestore and Pub/Sub emulators in CI; end-to-end test pushes one RSS item and asserts it is searchable and metered.
- **Load:** k6 at 50 requests per second on `/v1/search` before the finale.

**Scaling path**

| Trigger | Change |
| --- | --- |
| Over 1 million chunks or p95 search over 1 s | Move vectors to Vertex AI Vector Search; keep Firestore for metadata |
| Over 50,000 items per day | Gemini Batch API for cleaning and embeddings at lower cost; separate OCR subscription |
| Buyers asking for training data | Dataset export job: Parquet to Cloud Storage plus a signed manifest (hashes, licence versions) |
| Publishers outside India | Add regions per territory; keep each publisher's data in its home region |
| Distribution | List on Google Cloud Marketplace; offer the MCP server in agent registries |
