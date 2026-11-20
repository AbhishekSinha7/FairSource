export interface IngestConfig {
  /** Sent on every request, so publishers can see who is fetching. */
  userAgent: string;
  /** Minimum gap between requests to one host (1 request per second). */
  minIntervalMs: number;
  /** Largest page or file we fetch or accept. */
  maxBytes: number;
  timeoutMs: number;
  /** Work per call before saving progress, kept under the Cloud Run request timeout. */
  runBudgetMs: number;
  /** How long a source's lease lasts if a run dies without releasing it. */
  leaseMs: number;
  /** Re-check every live document at least this often. */
  staleCheckDays: number;
  /** Most HTTP checks one sweep makes per source. */
  sweepBatch: number;
  maxFeedPages: number;
  maxSitemapUrls: number;
  maxZipEntries: number;
  rawBucket: string;
  projectId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const n = (k: string, d: number) => (env[k] ? Number(env[k]) : d);
  const project = env.GOOGLE_CLOUD_PROJECT ?? 'fs-dev';
  return {
    userAgent: env.USER_AGENT ?? `FairSourceBot/0.1 (+${env.BOT_INFO_URL ?? 'https://fairsource.example/bot'})`,
    minIntervalMs: n('MIN_INTERVAL_MS', 1000),
    maxBytes: n('MAX_BYTES', 10 * 1024 * 1024),
    timeoutMs: n('FETCH_TIMEOUT_MS', 20_000),
    runBudgetMs: n('RUN_BUDGET_MS', 240_000),
    leaseMs: n('LEASE_MS', 330_000),
    staleCheckDays: n('STALE_CHECK_DAYS', 7),
    sweepBatch: n('SWEEP_BATCH', 200),
    maxFeedPages: n('MAX_FEED_PAGES', 200),
    maxSitemapUrls: n('MAX_SITEMAP_URLS', 50_000),
    maxZipEntries: n('MAX_ZIP_ENTRIES', 500),
    rawBucket: env.RAW_BUCKET ?? `${project}-raw`,
    projectId: project,
  };
}
