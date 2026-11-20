# Build Plan: FairSource, a Licensed Content Layer for AI

Nov 18, 2026 · @Abhishek

## Overview

We build a working end-to-end slice of the platform before the Pune City Buildathon (20–21 Nov), polish it for the regional showcase (23/25/27 Nov), and make it finale-ready for 2 Dec in Bengaluru. After that, we turn it into paid pilots within 90 days.

The product: publishers connect their content once, Gemini makes it AI-ready, AI buyers query only licensed content through an API or MCP server, and every use is metered and credited back to the publisher. No manual step anywhere in the flow.

**Demo goal:** an article in Marathi or Hindi goes from an RSS feed or a scanned PDF to a licensed, attributed answer in an AI agent, and the publisher's earnings counter moves, live, in under 60 seconds.

**Team:** Abhishek (product, platform, API, payments) and Akshay Bhor (data and AI pipeline). Both in Pune.

## MVP scope

The MVP proves the full loop (ingest, process, license, serve, meter) on a small real corpus. It does not need to be complete; every box in the architecture needs to run once.

| Area | In the MVP (20–21 Nov) | Later |
| --- | --- | --- |
| Ingestion | RSS/sitemap connector with backfill on connect, edits picked up as new versions, "Sync now", PDF/scan upload; deletion sweep if time allows | CMS plugins and webhooks (WordPress, Ghost), WebSub, scheduled re-crawl at scale |
| AI processing | Gemini OCR, clean and structure, language and script detection, metadata, Gemma dedup check | Quality scoring, entity linking, translation pairs |
| Index and rights | Gemini embeddings, Firestore vector search, rights registry (licence type, territory, opt-out) | Vertex AI Vector Search, per-buyer custom licences |
| Licensed access | Search/RAG API with attribution, API keys, MCP server with one tool | Dataset export with signed manifests, marketplace listings |
| Metering and payouts | Usage events in BigQuery, earnings computed per publisher, Stripe test mode | Live Stripe Connect and Razorpay payouts, statements |
| Dashboards | Publisher view (sources, licence toggles, earnings), buyer view (keys, usage) | Analytics, invoices, team accounts |

**Demo corpus:** only content we are allowed to use. Use openly licensed text (Marathi and Hindi Wikipedia and Wikisource, CC BY-SA), public-domain scanned books from Internet Archive for the OCR demo, and, if possible, one or two small Pune publishers or bloggers who agree in writing to be the first real source. Target about 2,000 articles in 3 languages (Marathi, Hindi, English) plus 50 scanned pages.

**Out of scope for the buildathon:** real money movement, legal contracts, multi-user organisations, and any scraping of sites without permission.

## Architecture and tech stack

The system is serverless and event-driven: each new article is a Pub/Sub message, processed in parallel by Cloud Run, so it scales with content volume and costs almost nothing when idle. Use one Google Cloud project, region asia-south1 (Mumbai).

&#91;embedded content: MVP architecture · 9 components on Google Cloud\]

Content flows along the top row into the index; buyers reach it only through the licensed API, and every call flows left into metering and back to the publisher as earnings.

| Component | Google Cloud / AI service | Language | Owner |
| --- | --- | --- | --- |
| Ingest service (RSS, sitemap, upload) | Cloud Run, Cloud Scheduler, Pub/Sub, Cloud Storage | TypeScript (Node) | Abhishek |
| Processing worker | Cloud Run (Pub/Sub push), Gemini API, Gemma via Gemini API | Python | Akshay |
| Embeddings and search index | Gemini embedding model (768 dimensions), Firestore vector search | Python | Akshay |
| Rights registry and metadata | Firestore | TypeScript | Abhishek |
| Licensed API (search, RAG answer) | Cloud Run behind API Gateway, Secret Manager for keys | TypeScript | Abhishek |
| MCP server for agents | Cloud Run (streamable HTTP MCP) | TypeScript | Abhishek |
| Metering | BigQuery (usage\_events table), scheduled query for earnings | SQL | Akshay |
| Dashboards | Next.js on Firebase App Hosting, Firebase Auth | TypeScript | Abhishek |
| CI/CD and ops | Cloud Build from GitHub, Cloud Logging, Cloud Monitoring | YAML | Both |

**How Gemini and Gemma are used**

- **Gemini Pro:** OCR and layout extraction from scanned Devanagari pages; licence-rule checks on edge cases.
- **Gemini Flash:** cleaning, structuring into JSON (title, author, date, body, topics), language and script tagging, attribution text for each answer, and the RAG answer itself.
- **Gemini embedding model:** multilingual vectors so a Hindi query can find a Marathi article.
- **Gemma (via Gemini API):** cheap high-volume checks, such as near-duplicate detection and content safety filtering, to keep cost per article low.
- **Google AI Studio:** design and test every prompt with structured output schemas before wiring it in. **Antigravity:** agent-assisted coding of the services.

**Why Firestore vector search, not Vertex AI Vector Search, for the MVP:** it needs no always-on index endpoint, so it is near-free at demo scale. Move to Vertex AI Vector Search once the corpus passes about a million chunks.

## Data model and API

Firestore collections and one BigQuery table cover the MVP; the full schema is in `packages/shared/src/schema.ts`. Every chunk carries its rights fields, so the API can filter out unlicensed content in the same query that finds it. A post is identified by its canonical URL, so an edit creates a new version of the same document, not a duplicate.

| Store | Collection / table | Key fields |
| --- | --- | --- |
| Firestore | publishers | id, name, country, payoutAccountRef, revenueSharePct |
| Firestore | sources | id, publisherId, type (rss, sitemap, upload), url, status, lastFetchedAt, backfill progress, syncRequestedAt |
| Firestore | documents | id = sha256(canonical URL), sourceId, publisherId, version, contentHash, title, author, publishedAt, language, script, topics\[\], rawUri, cleanUri, status (incl. withdrawn), lastSeenAt |
| Firestore | chunks | id = {docId}\_v{version}\_{n}, documentId, documentVersion, text, embedding (vector 768), language, licenceType, territories\[\], optOut |
| Firestore | licences | publisherId, licenceType (rag, training, both), allowedTerritories\[\], pricePer1kTokens, active |
| Firestore | buyers | id, name, apiKeyHash, plan, monthlyQuota |
| BigQuery | usage\_events | eventId, ts, buyerId, publisherId, documentId, documentVersion, chunkIds\[\], tokensServed, endpoint, amountMicros |

**Processing contract (one Pub/Sub message per new or changed item):** `{ docId, contentHash, sourceId, publisherId, rawUri, mimeType, reason }` → worker writes the document, replaces its chunks and embeddings, then publishes `content.processed`.

**Licensed API (v1)**

| Method | Path | What it does |
| --- | --- | --- |
| POST | /v1/search | Semantic search over licensed chunks; returns text, source, publisher, attribution, licence |
| POST | /v1/answer | RAG answer from Gemini Flash using only licensed chunks, with inline citations |
| GET | /v1/documents/{id} | Full licensed document and its metadata |
| GET | /v1/usage | The buyer's own usage and spend |

Every call checks the API key, filters by `optOut = false`, the buyer's territory and the licence type, then writes one row to `usage_events`.

**MCP server:** one tool, `search_licensed_content(query, language?, limit?)`, which calls /v1/search with the agent's key. This lets the demo show Gemini CLI, Claude or any MCP client pulling licensed, attributed Marathi content.

**Earnings:** a BigQuery scheduled query sums `amountMicros` per publisher per day, applies `revenueSharePct` (start at 75% to the publisher), and writes the result back to Firestore for the dashboard.

## Team split

Akshay owns everything between a raw file and a searchable chunk; Abhishek owns everything that publishers and buyers touch. The handover point is the `content.raw` message, the `documents` and `chunks` collections and the `usage_events` schema (all in `packages/shared/src/schema.ts`, mirrored in the worker's `models.py`), so agree on them on day one and do not change them during the buildathon.

| Workstream | Owner | Done when |
| --- | --- | --- |
| GCP project, IAM, Secret Manager, Cloud Build, repo | Abhishek | Both can deploy a Cloud Run service from main |
| Ingest service and connectors | Abhishek | An RSS URL and a PDF upload each produce Pub/Sub messages; connecting a blog imports its existing posts; editing a post replaces its chunks |
| Gemini prompts in AI Studio (OCR, clean, metadata) | Akshay | Each prompt returns valid JSON for 20 test items |
| Processing worker, dedup with Gemma | Akshay | 2,000 articles processed with no manual fixes |
| Embeddings and vector search | Akshay | A Hindi query returns the right Marathi article in the top 3 |
| Rights registry and licence filter | Abhishek | An opted-out article never appears in results |
| Licensed API and API keys | Abhishek | /v1/search and /v1/answer return attributed results |
| MCP server | Abhishek | An MCP client lists and calls the tool |
| BigQuery metering and earnings query | Akshay | Each API call adds a row; earnings update within 1 minute |
| Publisher and buyer dashboards | Abhishek | Live earnings counter and licence toggle work |
| Demo corpus and consent | Akshay | Licensed or public-domain corpus loaded, sources listed |
| Pitch, demo script, deck | Both | 3-minute run-through done twice without errors |

## Build schedule

The whole MVP has to come together in the two buildathon days, so the prep on 18–19 Nov decides whether it works. Check the buildathon rules on code written before the event; if building must happen there, keep prep to setup, prompts, schemas and data.

&#91;embedded content: buildathon timeline · 18 Nov to 2 Dec 2026\]

After the Pune event, each step adds proof (a backup video, then signed letters of intent) rather than new features.

**Before 20 Nov**

- [ ] Create the GCP project in asia-south1, enable APIs, set a USD 50 budget alert (Abhishek)
- [ ] Set up the repo (ingest, worker, api, mcp, web) and Cloud Build triggers (Abhishek)
- [ ] Agree and freeze schema v2: `documents`, `chunks`, `content.raw` and `usage_events` (Both)
- [ ] Build and test the OCR, cleaning and metadata prompts in AI Studio on 20 samples (Akshay)
- [ ] Collect the demo corpus and record each source's licence (Akshay)
- [ ] Message 3–5 Indic AI startups and 2 local publishers about letters of intent and consent (Abhishek)

**Day 1, 20 Nov**

- [ ] Morning: ingest service and worker deployed; the first article flows end to end (Both)
- [ ] Afternoon: OCR, cleaning, Gemma dedup and embeddings run on the full corpus (Akshay)
- [ ] Afternoon: rights registry and /v1/search with the licence filter (Abhishek)
- [ ] Evening: BigQuery metering and earnings query (Akshay); /v1/answer and API keys (Abhishek)

**Day 2, 21 Nov**

- [ ] Morning: MCP server and the publisher and buyer dashboards (Abhishek)
- [ ] Midday: opt-out flow, earnings counter, bug fixes (Both)
- [ ] Afternoon: two full demo rehearsals, record the backup video, final deck (Both)

**22 Nov to 2 Dec**

- [ ] Fix whatever the judges flagged; add dataset export with a signed manifest
- [ ] Run a Stripe Connect test-mode payout to one publisher
- [ ] Bring at least 2 signed letters of intent and 1 publisher consent to the finale

## Demo script and judging criteria

The demo runs in 3 minutes and shows one article travelling the whole loop live. Record a backup video of the same run in case the venue network fails.

1. **The problem (20 s):** ask a popular AI model a question about a recent Marathi local news story; show it answers poorly or makes something up.
2. **Publisher connects (30 s):** in the publisher dashboard, paste an RSS URL and upload one scanned page. Choose the licence (RAG only, India and global) in two clicks.
3. **AI processing (30 s):** show the live log: Gemini OCR on the scan, cleaned JSON, language and script detected, Gemma duplicate check passed, embedding stored.
4. **Buyer uses it (40 s):** in an MCP client, ask the same question in Hindi. The agent calls `search_licensed_content`, gets the Marathi article, and answers correctly with a citation to the publisher.
5. **Money moves (20 s):** switch to the publisher dashboard; the earnings counter has increased and the usage row shows which article was used.
6. **Control (20 s):** toggle opt-out on that article and repeat the query; it no longer appears.
7. **Close (20 s):** the market (non-English publishers, India first), the business model (take rate on every use), and the ask.

| Judging criterion | What we show |
| --- | --- |
| Founder profile | Shipped ISV products and security reviews (Abhishek) plus production data and AI/ML work at TCS (Akshay); complementary split |
| Product potential | Fully automated loop; works for any language; MCP makes it native for AI agents |
| Market viability | Real buyer demand (licensing deals signed by AI labs with Indian publishers), long-tail publishers underserved, clear take-rate model |
| Technical architecture | Serverless, event-driven, rights enforced at query time, audit trail in BigQuery |
| Depth of Google AI/Cloud use | Gemini Pro, Flash and embeddings, Gemma, AI Studio, Antigravity, Cloud Run, Pub/Sub, Firestore vector search, BigQuery, Firebase |

## Post-buildathon roadmap (90 days)

The goal for the first 90 days is 3 paying AI buyers using content from at least 10 publishers, which is the proof a seed investor will ask for. Each phase starts only once the previous gate is met.

&#91;embedded content: 90-day roadmap · 3 phases, 3 gates\]

Supply comes first because buyers will only sign for a real catalogue. The targets are ours to adjust after the first publisher conversations.

## Costs, risks and mitigations

The MVP should cost well under USD 50 in cloud spend, so the main risks are time and demand, not money. Figures below are approximate, based on list prices as far as we know; check the current Gemini pricing page before relying on them.

| Item (MVP corpus) | Volume | Approx. cost (USD) |
| --- | --- | --- |
| Gemini Flash cleaning and metadata | 2,000 articles, about 6M tokens | 5–15 |
| Gemini Pro OCR | 50 scanned pages | under 5 |
| Gemini embeddings | about 4M tokens | under 2 |
| Cloud Run, Pub/Sub, Firestore, BigQuery, Firebase | demo traffic | mostly free tier, under 10 |

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Two founders with full-time jobs, 2-day build | Demo incomplete | Freeze scope to the MVP table; prepare repo, prompts and corpus before 20 Nov |
| OCR quality on old Devanagari scans | Weak demo moment | Pre-test 50 pages in AI Studio and demo on the best 5; show raw vs cleaned side by side |
| Gemini API rate limits during the demo | Live run stalls | Pre-process the corpus; only the live upload runs in real time; keep a recorded backup |
| Using content without permission | Legal and credibility damage | Openly licensed and public-domain sources only, listed in the deck; written consent from any live publisher |
| Buyers may not pay (courts in India have been friendly to AI training as fair dealing) | Weak market story | Lead with RAG and agent use (live, per-query value), not training; collect 2–3 letters of intent from Indic AI startups |
| Big platforms (Cloudflare, TollBit, ProRata) move into Indian languages | Competition | Win the long tail on automation and OCR of print archives; distribute through their marketplaces rather than fight them |
| Venue network fails | No live demo | Run from a phone hotspot; recorded video ready |
