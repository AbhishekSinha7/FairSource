# FairSource

Publishers connect their content once. FairSource makes it AI-ready with Gemini, serves only licensed content to AI buyers through an API and an MCP server, and meters every use so publishers get paid. No manual step anywhere in the flow.

**Demo goal:** a Marathi or Hindi article goes from an RSS feed or a scanned PDF to a licensed, attributed answer in an AI agent, and the publisher's earnings counter moves, live, in under 60 seconds.

**Team:** Abhishek (product, platform, API, payments) and Akshay Bhor (data and AI pipeline).
**Dates:** prep 18–19 Nov 2026 · Pune City Buildathon 20–21 Nov · regional showcase 23/25/27 Nov · finale 2 Dec, Bengaluru.

Full plans: [Build Plan](Build%20Plan%20Licensed%20Content%20Layer%20for%20AI.md) · [Technical Implementation](Technical%20Implementation%20Licensed%20Content%20Layer%20for%20AI.md). This README records the decisions on top of them and where each one lives in the repo.

---

## Decisions

Each decision gives what we chose, why, and where it is implemented. Status is **decided** unless marked otherwise.

### 1. Product name: FairSource

The mockups and the plan documents' file names say "Licensed Content Layer"; that was a working title. All UI, copy, attribution text and identifiers use **FairSource**.

- Attribution text: `Source: <Publisher>, licensed via FairSource`
- API key format: `fs_<8-char prefix>_<secret>` (was `lcl_`)
- MCP server name in client config: `fairsource`
- GCP projects: `fs-dev`, `fs-prod`; buckets `fs-dev-raw`, `fs-dev-clean`

### 2. We store a copy of the content; we do not just reference it

FairSource keeps three copies of every article:

| Copy | Where |
| --- | --- |
| Raw page or scan, as fetched | `gs://<project>-raw/{publisherId}/{yyyy}/{mm}/{contentHash}.{ext}` |
| Cleaned JSON (title, body, metadata) | `gs://<project>-clean/` |
| Chunk text and embeddings | Firestore `chunks` |

**Why:** scans have no web page to point to; fetching live would add seconds to every search and break whenever the publisher's site is down; and we must be able to prove what text a buyer was served and paid for.
**Cost of this decision:** the copy must follow the publisher's site (decision 4), and when a post is removed we delete our copy (decision 6).

### 3. A post is identified by its URL, not by its text (schema v2)

The v1 design keyed `documents` by `contentHash`. An edit changed the hash, so the edited post became a *new* document marked `duplicateOf` the old one, and buyers kept getting the stale text.

**v2:**
- `docId = first 32 hex of sha256(identityKey)`, where `identityKey` is
  - `url:<canonical URL>` for web content (preferred, even when the feed has a GUID),
  - `guid:<sourceId>:<guid>` only for RSS items with no link,
  - `upload:<contentHash>` for uploaded files.
- Canonical URL: the page's `<link rel="canonical">` if same host, else the item URL normalised: `https`, lowercase host without `www.`, no port/fragment/credentials, tracking parameters (`utm_*`, `fbclid`, `gclid`, …) removed, remaining parameters sorted, no trailing slash.
- `contentHash` and `version` are fields. Same URL + new hash = `version + 1`.
- The same post found through RSS **and** the sitemap is now one document (`sourceIds[]` lists both), not a duplicate.
- The duplicate check (SimHash + Gemma) runs only against documents with a **different** `docId`: the same story republished at another URL.
- Chunk IDs are `{docId}_v{version}_{n}`, so a ledger row always points at the exact text that was served. Only the current version's chunks exist; old versions are recorded in `documents/{docId}/versions/{n}` (hash, counts, files).
- **Only the ingest service mints document IDs.** The worker and api read `docId` from messages and documents and never recompute it, so the URL normalisation exists in one place (TypeScript).

Implemented in [packages/shared/src/schema.ts](packages/shared/src/schema.ts) (`canonicalizeUrl`, `identityKeyFor`, `docIdFor`, `chunkIdFor`), tested in [schema.test.ts](packages/shared/src/schema.test.ts).

### 4. Keeping a connected blog in sync

| Change on the publisher's site | Detection | Result | Buildathon? |
| --- | --- | --- | --- |
| Blog connected | `sources.backfill.status = pending` | Backfill reads the full sitemap or pages back through the feed (WordPress `?paged=N`); resumable via `backfill.cursor`; progress shown on Sources | **Yes** |
| New post | 30-minute scheduled run, or **Sync now** | New `docId`, version 1 | **Yes** |
| Edited post | Every item in the current feed is re-hashed (the raw-file write is a no-op when unchanged); sitemap `lastmod` newer than `sourceModifiedAt` | `version + 1`, chunks replaced in one batch | **Yes** |
| Deleted post | Daily sweep: URLs missing from the sitemap, plus documents not checked for 7 days, get an HTTP `HEAD`; 404/410 = deleted | `status = withdrawn`, out of search within seconds | **Yes** (built) |
| Publisher removes it in the dashboard | Opt-out toggle or delete | Same as deleted, `withdrawnReason = publisher_removed` | Opt-out: **yes** |
| Instant updates | WordPress plugin / REST `modified_gmt` cursor, Ghost webhooks, WebSub | Seconds instead of ≤ 30 minutes | After the MVP |

Rules:
- A post missing from the **feed** is never treated as deleted. Feeds only show recent items. Only the sitemap diff plus an HTTP check can withdraw a post.
- Timeouts and 5xx responses never withdraw anything; they are retried on the next sweep.
- RSS ingest sends `If-None-Match` / `If-Modified-Since` (`sources.etag`, `sources.lastModifiedHeader`) to keep re-polling cheap.
- Feed discovery when the publisher pastes a site URL: `<link rel="alternate" type="application/rss+xml">` → `/feed`, `/rss` → `/sitemap.xml` and `Sitemap:` in `robots.txt`. Recorded in `sources.discoveredFrom`.
- Fetch politeness: respect `robots.txt`, one fetch at a time per domain, at most 1 request per second, a `User-Agent` naming FairSource, 10 MB per file.

### 5. Where each kind of data is stored

| Data | Store | Why |
| --- | --- | --- |
| Raw and cleaned files (large, write-once) | **Cloud Storage** | Cheap, any size; the `contentHash` path deduplicates for free and keeps every version |
| Publishers, sources, licences, documents, API keys (small, read on every request) | **Firestore** (Native mode) | Scales to zero, live listeners for the dashboard, no server to run |
| Chunks + embeddings | **Firestore vector search** (flat index, 768 dims) | Rights pre-filter and nearest-neighbour search in one query; no always-on index endpoint |
| Usage events and daily earnings (money) | **BigQuery** `ledger` | Append-only audit trail; payouts always recomputable |
| Live earnings counter | Firestore `earnings/{pubId}_{yyyymmdd}` | Sub-second for the demo. **Display only, never used for payouts** |
| Stripe, Razorpay, Gemini keys | **Secret Manager** | Never in code or env files |

Storage rules:
- The article body lives only in the cleaned JSON and in chunk text, never on the `documents` row, which keeps the Content page fast.
- Embeddings exist only on the current version's chunks.
- Raw files move to Nearline after 30 days ([infra/gcs-lifecycle.json](infra/gcs-lifecycle.json)).
- Size at demo scale: about 2,000 articles ≈ 14,000 chunks ≈ 130 MB in Firestore, inside the free tier.

**Considered and deferred: Postgres (Cloud SQL / AlloyDB + pgvector).** This data is relational (licences, versions, ledger), and in Postgres the rights check would be a join instead of copying rights onto every chunk. It loses for the buildathon: it runs all the time, it is one more thing to break in two days, and the Firestore + Vertex AI + BigQuery mix shows more depth of Google Cloud use. Revisit at about 1M chunks or a p95 search time over 1 s. At that point move vectors to Vertex AI Vector Search, or move everything to AlloyDB.

### 6. Deleting withdrawn content

When a post is withdrawn:
1. Ingest sets `status = withdrawn`, `servable = false`, `withdrawnAt`, `withdrawnReason`.
2. The Eventarc re-stamp function (already in the design for opt-out and licence changes) sets `servable = false` on its chunks, so they leave search within seconds.
3. A cleanup job deletes the chunks, the raw and clean files, and clears the file URIs on the version rows. We no longer hold the text of a post the publisher took down.
4. The document row (title, IDs, hashes) and every ledger row stay, so past earnings and statements stay correct.

No new Pub/Sub topic is needed.

### 7. Money comes from the ledger only

- One API call writes one `usage_events` row **per publisher**, so payouts never split a row.
- Rows carry `licence_id`, `licence_version` and (v2) `document_version`, so the terms and text in force at the time of use can always be proven.
- Pub/Sub is at-least-once; every ledger query de-duplicates on `event_id`.
- Revenue share (75% to the publisher) is applied at payout time, so changing it never rewrites history. Balances under USD 10 roll over. Payouts run on the 3rd of each month, in Stripe / Razorpay test mode for the MVP.

DDL: [infra/ledger.sql](infra/ledger.sql). If a v1 table already exists: `ALTER TABLE ledger.usage_events ADD COLUMN IF NOT EXISTS document_version INT64;`

### 8. Rights are enforced at query time, in one function

A chunk is returned only if it is servable and not opted out, its licence allows the requested use (`rag` / `training`), its territories include `GLOBAL` or the buyer's country, and the buyer is active. The same `isServable()` is used by search, answer, documents and MCP. Rights fields are copied onto chunks so search filters without joins, and they are re-stamped within seconds when a licence or opt-out changes.

Implemented in [services/api/src/rights.ts](services/api/src/rights.ts), tested in [rights.test.ts](services/api/src/rights.test.ts).

### 9. Schema freeze and handover

- The handover point between ingest/api (Abhishek) and the worker (Akshay) is: the `content.raw` message, the `documents` and `chunks` collections, and `usage_events`.
- **Schema v2 must be agreed by both before 20 Nov**, then not changed during the buildathon. **Status: written, awaiting Akshay's review.**
- [schema.ts](packages/shared/src/schema.ts), [models.py](services/worker/src/worker/models.py) and [ledger.sql](infra/ledger.sql) change together in one pull request reviewed by both.
- `content.raw` carries `schemaVersion: 2` and a `reason` (`new | changed | backfill | manual_sync`). The worker rejects messages that fail validation with a 400, so Pub/Sub does not retry them forever.

### 10. Pre-event code is allowed

Confirmed on 19 Nov: the buildathon allows code written before the event, so we build features now instead of only setup. Order: dashboard screens first (on mock data in `web/lib/mock.ts`, behind `web/lib/data.ts`), then ingest and the worker, then wire the dashboards to Firestore.

**Dev machine note:** `npm install` only works from Command Prompt (`cmd`), not PowerShell.

### 11. Tooling choices

| Choice | Why |
| --- | --- |
| npm workspaces (the plan said pnpm) | pnpm is not installed on the dev machine; npm works the same for this monorepo. Switching later is a lockfile change. |
| TypeScript (Node 22) for ingest, api, mcp, web; Python 3.12 for the worker | As in the plan. Local Python is 3.15; use `py -3.12` for the worker, because pydantic may not ship 3.15 wheels yet. |
| Fastify; functions-framework for the worker | The worker needs only one Pub/Sub push handler. |
| One `services/Dockerfile.node` with `--build-arg SERVICE=` | Three TS services share one image recipe. |
| One `cloudbuild.yaml`, one trigger per service (`_SERVICE`, included-files filter) | Only the changed service redeploys. |
| Model IDs in [prompts/models.json](prompts/models.json), not code | So models can be upgraded. **To do:** fill in the current IDs from AI Studio. |
| Next.js 15 + Tailwind v4, design tokens in [web/app/globals.css](web/app/globals.css) | Taken from the mockups. |

### 12. UI follows the 18 Nov mockups

The mockup layout: a dark sidebar with a Publisher/Buyer toggle, a warm off-white page, white bordered cards, and dark cards for hero and code panels. Indigo is the primary colour. Status pills are green (Servable, Healthy), amber (Needs review), red (Not served) and grey (Duplicate, Withdrawn, Coming soon, Revoked). Monospace is used for keys, licence tags, timestamps and prices, and Devanagari is fully supported.

Screens: **Publisher**: Earnings, Sources, Licence, Content. **Buyer**: Playground, API keys & MCP, Usage.

Sync features go into the existing screens, not new pages:
- **Sources:** a **Sync now** button per row; Status shows `Backfilling · 340 of 1,612` until done, then `Healthy`.
- **Content:** a grey `Withdrawn · removed from your site` pill (Uses frozen); an `Updated · v2` note under the title.
- **Processing panel:** the duplicate step reads "no matching story at another URL".
- The Content duplicate row reads "same story at another URL" (decision 3), and keys are `fs_…` (decision 1). The built UI follows these; the mockup images do not.

### 13. Dashboard build (19 Nov)

All seven screens are built in `web/` and run on demo data:

| Screen | Path | What works now |
| --- | --- | --- |
| Earnings | `/publisher/earnings` | Live counter and recent uses (a new demo use every 4.5 s); 7/30-day chart; **Download statement** (real CSV); month tiles and payout from ledger figures only |
| Sources | `/publisher/sources` | Connect a feed or sitemap (site-URL discovery, consent required, backfill progress); upload with 10 MB check and drag-and-drop; **Sync now**; processing panel replay |
| Licence | `/publisher/licence` | Use and territory toggles, price validation, live licence tag preview, **Save as version N** adds to history, warning when nothing would be served |
| Content | `/publisher/content` | Title search, language filter, paging, opt-out toggle (updates the servable count; disabled for withdrawn posts), all status pills |
| Playground | `/buyer/playground` | Search and Answer modes, language chips, result limit, key scope check, This call stats, live curl with Copy |
| API keys & MCP | `/buyer/keys` | Create key (shown once, with Copy), two-step revoke, MCP config for Claude and Gemini CLI |
| Usage | `/buyer/usage` | Tiles, quota bar, tokens per day, by endpoint, by language, publishers used |

- **Data:** pages read only from `web/lib/data.ts`, which returns `web/lib/mock.ts` today. The mock figures add up (shares, totals, prices). Wiring Firestore and BigQuery means replacing the `data.ts` function bodies and keeping their return shapes; the actions (save licence, opt out, sync, create key) become server actions.
- **Status rules** live in one place, `web/lib/status.ts`, in the same order as `servable` in the shared schema.
- **Fonts:** Inter, Space Grotesk, JetBrains Mono and Noto Sans Devanagari, loaded from Google Fonts by a `<link>` in `app/layout.tsx`. `next/font` was dropped because it downloads fonts at build time, and that failed on this network.
- **Snippet domain:** set `NEXT_PUBLIC_FAIRSOURCE_DOMAIN` to replace `[YOUR DOMAIN]` in the curl and MCP snippets.
- **Checked:** `next build` passes (types included); every screen screenshotted at 1440 px and three at 390 px.

### 14. Ingest service build (19 Nov)

`services/ingest` is fully implemented: RSS/Atom/RDF and sitemap connectors, resumable backfill, edit detection, the deletion sweep, uploads with ZIP expansion, and feed discovery. Design choices made while building it:

| Choice | Why |
| --- | --- |
| Send an item when its hash differs from the document's `contentHash` **and** `pendingContentHash`; ignore whether the raw file already exists | The plan's "publish if the raw-file write succeeded" would miss an edit that is later reverted (A → B → A), because A's file already exists |
| Hash the article text (`<article>` / `<main>` / `<body>`, minus nav, header, footer, sidebars, scripts), not the whole page | Rotating ads, "related posts" and tracking scripts would otherwise look like an edit on every run and waste worker and Gemini calls. Pages with almost no text (JavaScript-rendered) and all files hash their bytes |
| An edited document keeps `status` and `servable`; only `pendingContentHash` is set | Buyers keep getting the current version until the worker swaps in the new one, instead of the article vanishing from search during reprocessing |
| `pendingContentHash` is set only **after** `content.raw` is published | If publishing fails, the next run sees no pending hash and sends again |
| Scheduler calls `run-due` every **5** minutes (sources still run every 30) | A backfill works for 4 minutes per call and saves its cursor; at every 30 minutes a 1,600-post blog would take hours to import |
| A lease on each source (`sources.leaseUntil`, schema addition) | Overlapping scheduler calls or a "Sync now" during a run never process a source twice |
| Sitemap runs fetch a page only if it's new, withdrawn, or its `lastmod` is newer than the document's | Feeds are small and are re-hashed in full; sitemaps can list thousands of URLs |
| A document is found by its URL key **or** by `publisherId + sourceUrl` | When a page's `<link rel="canonical">` differs from its sitemap URL, the sitemap check still finds it and doesn't refetch it every run |
| Sweep candidates: missing from the sitemap and not checked for a day, or not checked for 7 days (measured from `lastSeenAt` if never checked); at most 200 per source per day | News sitemaps list only recent posts, so "missing" alone would re-check the whole archive daily |
| `robots.txt` that can't be fetched (5xx, network) blocks the site until the next try; a missing one (404) allows all | RFC 9309 behaviour; we never fetch a site whose rules we can't read |
| `robots.txt`, 1 request per second per host, one request at a time per host, 10 MB cap, 20 s timeout | Fetch politeness from decision 4 |
| Uploads go to `uploads/{publisherId}/{sourceId}/{uuid}/{file}` in the raw bucket; Eventarc calls `/internal/upload-finalized`; the staged file is deleted after processing | The browser uploads directly with a 15-minute signed URL, so files never pass through a server |
| ZIPs: skip folders, `__MACOSX`, hidden files and unsupported types; at most 500 files, 10 MB each, 200 MB in total | Guard against ZIP bombs and junk entries; rejected names are logged |
| Canonical URL keeps non-default ports (shared schema fix) | Dropping them would merge different sites on one host |
| Feed discovery accepts `localhost` | Local testing only |

**How the dashboard calls it:** "Sync now" sets `syncRequestedAt` and calls `POST /internal/run`; "Connect and import" calls `POST /internal/discover`, then creates the source with `newSource()` from the shared package (backfill pending); uploads call `POST /uploads/sign`.

**Local run without Google Cloud:** `INGEST_BACKEND=memory npm run dev -w services/ingest` adds `POST /dev/sources` and `GET /dev/state`.

**Checked:** 25 tests (parsers, plus end-to-end scenarios against a fake website: backfill, re-runs, edits, ad changes, A→B→A, RSS + sitemap dedup, robots.txt, lease, errors, WordPress paging, ETag, sweep 404 vs 503, restore, resumable backfill, ZIP uploads, upload validation, discovery). Also a live smoke test of the HTTP server against a local site: discovery via `<link rel>`, backfill of 2 posts, an edit re-sent under the same document ID.

**Not yet exercised against real Google Cloud:** the Firestore, Cloud Storage and Pub/Sub adapters in `gcp.ts` compile, but have only run through the in-memory versions. Test them once `fs-dev` exists.

**Worker contract:** a new document arrives as a stub (version 0, `contentHash: ''`, status `queued`, title from the feed or `<title>`). The worker (decision 15) implements the rules for processing it.

### 15. Worker build (19 Nov)

`services/worker` is fully implemented (the ten steps in "Processing pipeline" in the Technical Implementation doc). Design choices made while building it, where they differ from or add to the plan:

| Choice | Why |
| --- | --- |
| A PDF is **one document**, OCR'd in 10-page parts (up to 300 pages) | The plan made each 10-page part its own message, which would turn one book into several documents with separate earnings and titles |
| OCR sends the file inline, not as a `gs://` URI | Works with both an AI Studio key (development) and Vertex AI (production); files are at most 10 MB |
| Local language check uses scripts and marker words, not fastText | fastText needs a native build on Windows and a model file; this check catches the mistakes that matter (wrong script, Marathi vs Hindi) and has no opinion otherwise. It can be swapped for fastText later behind `language_agrees()` |
| Duplicates only within the same publisher, and only "same article", not "same event" | Two papers covering one event are both legitimate; a cross-publisher "duplicate" would move one publisher's earnings to another |
| SimHash over word 3-shingles, 4 × 16-bit bands, Gemma asked only for the 3 closest candidates within 8 bits | Keeps Gemma calls near zero for normal articles |
| 10+ phone numbers or emails mark `pii_heavy` without a model call; an unreadable safety label sets `needsReview` | Lists of people (like the mockup's Ganeshotsav volunteer list) are caught cheaply; an unreadable answer never defaults to "serve" |
| `cleanHash`: if the cleaned article is unchanged, record the new page hash and stop | Comment counts or layout changes that get past ingest's text fingerprint still don't cost embeddings or a new version |
| `processedFetchedAt`: a message from an older fetch than the last one processed is ignored | Pub/Sub doesn't guarantee order; an old edit arriving late must not overwrite a newer one |
| The final write is a transaction that re-reads the document, and computes `servable` and chunk `optOut` inside it | A publisher's opt-out or a withdrawal during processing is never overwritten, and two deliveries of one message can't both write a version |
| An edit that fails permanently keeps the current version live | Buyers keep getting the last good version |
| Malformed messages return 204, not 400 | Pub/Sub push retries every non-2xx, so the skeleton's 400 would have bounced them to the dead-letter topic; they are logged instead |
| Stored `tokenCount` from Gemini `count_tokens`; chunk sizing uses a local estimate | Metering bills on `tokenCount`, so it should be the model's real count; the estimate is only for splitting |
| Gemma via the Gemini API (`GEMMA_API_KEY` on Vertex), falling back to Flash | Gemma isn't on Vertex AI's Gemini endpoint |
| Embedding falls back to one input per request if a batch is refused | Some endpoints accept only one input per call |
| Model IDs filled in `prompts/models.json` (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-embedding-001`, `gemma-3-27b-it`) | Known-good defaults; check AI Studio for newer ones and change the file, not code |
| New worker-owned document fields: `cleanHash`, `processedFetchedAt`, `processingError` (shared schema and `models.py`) | The bookkeeping above |
| Python `>=3.12` (was pinned to 3.12) | Developed and tested on 3.15 locally; the container still uses 3.12 |

**Checked:** 37 tests: text utilities (language, SimHash, chunker), the pipeline end to end with in-memory storage and a scripted AI (new article, redelivery, edit, page-only change, late old fetch, withdrawn, duplicate, unrelated article, language disagreement, personal data, unreadable safety label, opt-out, invalid model output for new and edited documents, 23-page PDF in 3 OCR calls, unsupported and empty files, missing stub, no licence), the HTTP status codes, and the Gemini client (retry with validation error, backoff then retryable, 4xx permanent, label parsing, embedding normalisation and batch fallback, schema accepted by the SDK). Also the production entry point loaded through functions-framework exactly as the container runs it.

**Not yet run:** real Gemini calls (no API key on this machine) and real Firestore, Storage and Pub/Sub. To try Gemini without Google Cloud: `set GEMINI_API_KEY=...` then `.venv\Scripts\python scripts\try_gemini.py <article URL or PDF>` from `services/worker`.

### 16. Licensed API and MCP server build (19 Nov)

`services/api` and `services/mcp` are implemented. Choices made while building them:

| Choice | Why |
| --- | --- |
| **Rights are re-checked live** on every result: the chunk's document (withdrawn, opted out, duplicate, under review, unsafe, outdated version) and the publisher's licence (cached 30 s) | Correct even if chunk re-stamping lags or fails: an opt-out or withdrawal applies on the next request, a licence change within 30 s. This replaces the Eventarc re-stamp function as the safety mechanism |
| `POST /internal/restamp` (shared secret `internal-token`) keeps chunk fields in step | Only needed so the vector pre-filter matches again, e.g. an article that is opted back in. The web app calls it after opt-out and licence saves |
| **Minimum relevance** `MIN_SCORE` (0.35) before metering | Found in the live smoke test: an unrelated query returned three articles and charged for them. Calibrate the value with real embeddings |
| One ledger row per **document**, not per publisher | A row has one `document_id` and `document_version`; payouts sum rows anyway |
| Ledger first (503 and nothing served if it fails), counters after (best effort) | "Nothing is served unmetered"; counters only drive dashboards |
| `/v1/answer` meters every source given to the model; a model failure charges nothing; no sources means no model call | The buyer pays for licensed content used, not for failures |
| `/v1/documents/{id}` returns 404 for anything not licensed to the caller | Never reveals that an unlicensed document exists |
| `/v1/usage` reads daily `buyerUsage` counters (Firestore), not BigQuery | No BigQuery in the request path; invoices still come from the ledger |
| Counter days use India time; the earnings `MERGE` now uses `DATE(ts, 'Asia/Kolkata')` | Dashboard "today" and ledger days use the same boundary |
| Key check: format `fs_<8>_<secret>`, SHA-256 compared in constant time, key cached 60 s (revocation within 60 s), buyer cached 10 s | As planned; the buyer cache keeps quota checks current |
| Rate limit 60/min per key and the monthly quota are per instance | Fine at buildathon scale; a shared limiter (Redis/Memorystore) comes with scale |
| MCP: stateless, a new server per request, JSON responses; it calls the public API with the buyer's key and `x-fairsource-client: mcp` | Same rights and metering as REST, recorded as `endpoint = mcp`; no Firestore access in `mcp` |
| MCP: no key → 401 at connect; wrong or revoked key → tool error the agent can show | Agents get a readable reason instead of a crash |
| `licenceTag()` moved to the shared package | API and dashboard print `rag/IN+GLOBAL/v3` the same way |
| Local demo mode `API_BACKEND=memory` seeds the mockup's publishers, articles (including an opted-out and a withdrawn one) and a key | Try the API and MCP without Google Cloud |

**Checked:** 22 API tests (auth, revocation after cache, scope, rate limit, quota, cross-language search, opt-out and withdrawal excluded before re-stamp, territory and use from the live licence, licence switched off, language filter, metering rows and counters, MCP label, ledger failure, irrelevant query, invalid input, answer with citations, model failure, no sources, documents, usage, restamp) and 4 MCP tests with a real MCP client → MCP server → API over HTTP. Also both servers run as processes and called with curl.

**Not yet run against real services:** Gemini query embeddings and answers, Firestore vector search, and the Pub/Sub → BigQuery subscription. On `fs-dev`, check that BigQuery accepts the `ts` field as an ISO string; if not, send epoch microseconds.

### 17. Cleanup of withdrawn posts (19 Nov)

`ingest` now deletes the stored content of withdrawn documents at the end of the daily sweep (also `POST /internal/cleanup`): their chunks, the cleaned JSON of every version, and raw files. A raw file is kept if another live document of the same publisher still points at it (identical text at another URL shares the content-hash path). The document row, its hashes and every ledger row stay; `cleanedAt` records when it ran, and a restored post is fetched and processed again. Ingest needs `storage.objectUser` on the clean bucket (`infra/setup.sh`). Tested with a document that has two versions and a raw file shared with a duplicate.

### 18. Dashboards on real data (19 Nov)

| Choice | Why |
| --- | --- |
| Two modes, switched with **Data: Demo / Live** at the top of the sidebar (a per-browser cookie). `DATA_BACKEND=firestore` makes Live the default; `DATA_MODE_LOCKED=1` hides the switch and fixes the mode (set it in production). Choosing Live before Firebase is configured shows a "not connected yet" page with the setup steps and the way back | The demo mode keeps the pitch and offline work independent of the cloud; both return the same shapes from `web/lib/data.ts` |
| Sign-in: Firebase Auth with Google, exchanged for an httpOnly `__session` cookie (5 days) with `role` and `orgId` custom claims; checked on every page and action | `__session` is the only cookie Firebase App Hosting forwards; claims make every query organisation-scoped |
| `infra/create-org.ts` creates a publisher (with licence v1 and an Uploads source) or buyer and links a Google account | No self-serve sign-up for the buildathon; onboarding UI later |
| All reads and writes go through the Next.js server (Admin SDK); Firestore rules deny every client read and write | One place for permission checks |
| Opt-out and licence save write Firestore, then call the API's `/internal/restamp` | The API already applies them live; re-stamping keeps the index pre-filter in step |
| Connect, Sync now: through `ingest` with a Google ID token (Cloud Run IAM); the action waits for the run (up to 55 s) and reports what it found | A long backfill continues on the 5-minute schedule; deploy `ingest` with `--no-cpu-throttling` so a run keeps going if the dashboard stops waiting |
| Uploads: the browser PUTs each file to a 15-minute signed URL from `ingest`; Eventarc starts processing | Files never pass through the dashboard server |
| API keys: generated on the server, stored as a SHA-256 hash, shown once | As in the plan |
| Playground: the dashboard calls the real API with the internal token and the chosen key's prefix (`x-fs-buyer`, `x-fs-key-prefix`); the API checks the key belongs to the buyer and isn't revoked | The dashboard never holds full keys, yet Playground calls are metered under the right key |
| "Live" earnings: the page re-reads its data every 5 seconds | Simpler than client Firestore listeners with rules; well inside the demo's "under 60 seconds" |
| New API counters: `documentUsage/{docId}_{yyyymm}` (Top articles, Content "Uses"), `publishers/{id}/recentUses` (7-day TTL), `buyerUsage.publishers` (Publishers you used), `earnings.uses` | The dashboards needed them and BigQuery isn't in the request path |
| The processing panel shows the latest processed document's real checks; a failed check gets an amber mark | Explains in the UI why an article isn't served |

**Checked:** type-checks and production builds in both modes; in live mode, without a session the pages redirect to `/login`, a forged session cookie is rejected, and the session route refuses missing and forged tokens; demo mode screens unchanged (all 7 pages 200, screenshots compared). The API's Playground path has a test (metered under the chosen key; wrong token or wrong buyer refused).

**Not yet run against real Firebase/Firestore:** sign-in, every Firestore query in `web/lib/server/live.ts` and the server actions. Run them on `fs-dev` after `infra/setup.sh` (indexes take a few minutes to build; a missing index shows as an error with a link that creates it).

### 19. API documentation (19 Nov)

The public API is described in OpenAPI 3.1 (`packages/shared/src/openapi.ts`) and rendered with [Scalar](https://scalar.com) at **`/docs`** in the web app, opened in a new tab from the buyer sidebar ("API docs") and the API keys page. The raw document is at `/openapi.json` on both the web app and the API.

| Choice | Why |
| --- | --- |
| Spec in the shared package | The API and the web app serve the same document |
| `services/api/src/openapi.test.ts` checks the spec against the code: every documented route exists, the spec's request examples are accepted, the documented limits are the enforced ones, real responses have every field the spec promises, documented error codes are the ones returned | Docs can't drift from the API unnoticed |
| Scalar 1.76.4 from jsDelivr, pinned; the spec is embedded in the page | No new dependency; the docs work even when the API isn't running |
| FairSource colours and fonts on Scalar's theme variables; Scalar's developer toolbar and "Ask AI" turned off | Keeps the page on-brand and keeps buyers' questions out of a third-party service |
| The API now allows cross-origin calls to `/v1/*` and `/openapi.json` (any origin; only `authorization` and `content-type` headers) | Scalar's "Test request" and buyers' browser apps can call the API. Keys are bearer tokens, not cookies, so this is safe; internal routes and headers are not exposed |
| `/docs` and `/openapi.json` are public in live mode | Prospective buyers can read the docs before they have an account |
| Set `NEXT_PUBLIC_FAIRSOURCE_DOMAIN` (web) and `PUBLIC_API_URL` (api) | Puts the real API URL first in the docs' server list |

### 20. One-command deploy (20 Nov)

`infra/deploy.sh` builds and deploys everything to Cloud Run and wires it together, on any Google Cloud account, from Cloud Shell. Run it after `infra/setup.sh`:

```bash
PROJECT=my-project FIREBASE_API_KEY=AIza... GEMINI_API_KEY=... ADMIN_EMAIL=you@gmail.com bash infra/deploy.sh
```

| What it does | Notes |
| --- | --- |
| Builds 5 images in Cloud Build in parallel (`infra/build-image.yaml`): ingest, api, mcp (`services/Dockerfile.node`), worker, and the dashboard (`web/Dockerfile`, Next.js standalone) | `.gcloudignore` keeps `node_modules`, builds and every `.env*` file out of the upload |
| Deploys to Cloud Run: `api`, `mcp` and `web` public; `ingest` and `worker` private (IAM) | `ingest` runs with `--no-cpu-throttling` so a backfill continues if the dashboard stops waiting |
| Gemini: with `GEMINI_API_KEY`, stored in Secret Manager (`gemini-api-key`) for worker and api; without it, Vertex AI in location `global` | |
| New `sa-web` service account for the dashboard: Firestore, Firebase Auth admin, the internal token, invoker on ingest | |
| Wiring: Pub/Sub push `content.raw` → worker (dead-letter after 5), scheduler jobs `run-sources` (every 5 min) and `sweep-sources` (daily), Eventarc `upload-finalized`, invoker grants | Re-running updates everything in place |
| With `ADMIN_EMAIL`, links that Google account as publisher `pub_example` (`create-org.ts`) | |
| Prints the URLs and the one manual step left: add the dashboard's domain to Firebase Auth's authorized domains | |

The dashboard can also run on a PC against the deployed services: `web/.env.local` with `INGEST_URL`, `API_URL` and `INTERNAL_TOKEN`. Calls to the private ingest then use `gcloud auth print-identity-token`, because a personal login can't mint ID tokens through the library.

**Checked locally:** the standalone dashboard server runs exactly as the container does (all pages, `/docs`, assets, sign-in guard); scripts parse; type-checks pass. **Not yet run:** the Cloud Build images and the deploy itself. The first run on the new account is the test; paste any failing build log.

---

## Repository layout

| Path | What | Language | Owner |
| --- | --- | --- | --- |
| `packages/shared` | Data model, schema v2 (single source of truth), ID helpers | TS | Both |
| `services/ingest` | RSS, sitemap, uploads, backfill, sync sweep; mints document IDs | TS | Abhishek |
| `services/worker` | OCR, clean, dedup, chunk, embed (`models.py` mirrors the shared schema) | Python 3.12 | Akshay |
| `services/api` | `/v1` search, answer, documents, usage; rights check; metering | TS | Abhishek |
| `services/mcp` | MCP server wrapping `/v1/search` | TS | Abhishek |
| `web` | Publisher and buyer dashboards (Next.js) | TS | Abhishek |
| `prompts` | Gemini prompts and response schemas, versioned; model IDs | JSON | Akshay |
| `infra` | `setup.sh`, ledger DDL, Firestore rules, bucket lifecycle | Bash/SQL | Abhishek |
| `eval` | Golden articles, retrieval queries, sync fixtures | — | Akshay |

**Service routes** (all implemented)

| Service | Routes |
| --- | --- |
| ingest | `GET /health`, `POST /internal/run-due` (scheduler, every 5 min), `POST /internal/run` (Sync now), `POST /internal/sweep` (daily, then cleanup), `POST /internal/cleanup`, `POST /internal/discover`, `POST /uploads/sign`, `POST /internal/upload-finalized` (Eventarc) |
| api | `GET /v1/health`, `POST /v1/search`, `POST /v1/answer`, `GET /v1/documents/:id`, `GET /v1/usage`, `GET /openapi.json`, `POST /internal/restamp` (internal token) |
| mcp | `GET /health`, `POST /mcp` (tool `search_licensed_content`; GET/DELETE 405) |
| web | dashboards, `GET /docs` (API reference), `GET /openapi.json`, `POST/DELETE /api/session` |
| worker | `POST /` Pub/Sub push for `content.raw` (200 done, 204 malformed, 503 retry), `GET /health` |

## Local development

```bash
npm install           # from Command Prompt (cmd), not PowerShell
npm run build         # shared + ingest + api + mcp
npm test              # 57 tests: shared, ingest, api, mcp (worker: 37 more, see below)
API_BACKEND=memory PORT=8097 npm run dev -w services/api        # demo data; the demo key is printed in the log
API_BASE=http://localhost:8097 PORT=8096 npm run dev -w services/mcp   # MCP at http://localhost:8096/mcp
npm run dev:web       # http://localhost:3000 (demo data)
# real data: set DATA_BACKEND=firestore and the web variables in .env.example, then
npx tsx infra/create-org.ts --project fs-dev --role publisher --id pub_example --name "Example Marathi Daily" --email you@example.com

# ingest without Google Cloud (in-memory backend)
INGEST_BACKEND=memory PORT=8098 npm run dev -w services/ingest
curl -X POST localhost:8098/dev/sources -H 'content-type: application/json' -d '{"type":"rss","url":"https://blog.example.org/feed"}'
curl -X POST localhost:8098/internal/run -H 'content-type: application/json' -d '{"sourceId":"<id from above>"}'
curl localhost:8098/dev/state

cd services/worker && py -m venv .venv && .venv\Scripts\python -m pip install -e ".[dev]" && .venv\Scripts\python -m pytest   # Command Prompt
```

Copy `.env.example` to `.env` for local settings. `.env` is git-ignored.

## Cloud setup

```bash
PROJECT=fs-dev ./infra/setup.sh
```

Creates APIs, Firestore, both buckets (with lifecycle), the BigQuery ledger, Pub/Sub topics and the BigQuery subscription, Artifact Registry, one service account per service with only its roles, the Firestore indexes (vector index on `chunks`; Content page indexes on `documents`), signing rights for upload URLs, and the Eventarc permissions. Set the USD 50 budget alert in the console.

After the first deploy of each service, grant invokers:

```bash
gcloud run services add-iam-policy-binding ingest --region=asia-south1 --member=serviceAccount:sa-scheduler@fs-dev.iam.gserviceaccount.com --role=roles/run.invoker
gcloud run services add-iam-policy-binding worker --region=asia-south1 --member=serviceAccount:sa-pubsub@fs-dev.iam.gserviceaccount.com    --role=roles/run.invoker
```

Also grant the web app's service account `roles/run.invoker` on `ingest` (Sync now, discovery, upload URLs). `api` and `mcp` are public (`--allow-unauthenticated`): buyers authenticate with API keys. Deploy `api` with `--set-secrets=INTERNAL_TOKEN=internal-token:latest` and `mcp` with `API_BASE=https://api.<domain>`.

Then create the worker push subscription (with dead-letter topic), the scheduler jobs (`run-sources` every 5 minutes, `sweep-sources` daily) and the `upload-finalized` Eventarc trigger, as in "Wiring after the first deploy" in the Technical Implementation doc. Deploy `ingest` with `--timeout=300`.

## Open items

- [ ] Akshay reviews and agrees schema v2 (`schema.ts`, `models.py`, `ledger.sql`) before 20 Nov
- [ ] Check the model IDs in `prompts/models.json` (gemini-2.5-*, gemini-embedding-001, gemma-3-27b-it) against what AI Studio offers now
- [ ] Run ingest against `fs-dev` (Firestore, Storage, Pub/Sub adapters untested against real services) and one real publisher feed
- [ ] Run `scripts/try_gemini.py` with a Gemini key on 5 real Marathi/Hindi articles and 2 scans; tune prompts if needed
- [ ] Calibrate `MIN_SCORE` with the retrieval eval set once real embeddings exist
- [ ] On `fs-dev`: enable Google sign-in in Firebase Auth, run `create-org.ts` for one publisher and one buyer, and click through every dashboard action (decision 18)
- [ ] Deploy the web app on Firebase App Hosting with `DATA_BACKEND=firestore`; give its service account `datastore.user`, `run.invoker` on `ingest`, Secret Manager access to `internal-token`, and Firebase Auth admin
- [ ] On the new Google Cloud account: `infra/setup.sh`, enable Google sign-in, `infra/deploy.sh`, add the dashboard domain to Firebase authorized domains (decision 20)
