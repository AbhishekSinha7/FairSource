export interface ApiConfig {
  projectId: string;
  location: string;
  /** Must match the worker's models (prompts/models.json), or query vectors won't match chunk vectors. */
  embeddingModel: string;
  embeddingDims: number;
  answerModel: string;
  /** Nearest-neighbour candidates fetched before licence filtering. */
  candidates: number;
  /**
   * Results below this relevance (1 − cosine distance) are dropped before metering,
   * so a buyer is never charged for unrelated articles. Calibrate with eval/retrieval.
   */
  minScore: number;
  requestsPerMinute: number;
  keyCacheMs: number;
  licenceCacheMs: number;
  /** Shared secret for /internal/* (web app and ingest). Unset = internal routes disabled. */
  internalToken: string | null;
  timeZone: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const n = (k: string, d: number) => (env[k] ? Number(env[k]) : d);
  return {
    projectId: env.GOOGLE_CLOUD_PROJECT ?? 'fs-dev',
    location: env.GOOGLE_CLOUD_LOCATION ?? 'asia-south1',
    embeddingModel: env.MODEL_EMBEDDING ?? 'gemini-embedding-001',
    embeddingDims: n('EMBEDDING_DIMS', 768),
    answerModel: env.MODEL_FLASH ?? 'gemini-2.5-flash',
    candidates: n('CANDIDATES', 50),
    minScore: n('MIN_SCORE', 0.35),
    requestsPerMinute: n('REQUESTS_PER_MINUTE', 60),
    keyCacheMs: n('KEY_CACHE_MS', 60_000),
    licenceCacheMs: n('LICENCE_CACHE_MS', 30_000),
    internalToken: env.INTERNAL_TOKEN || null,
    timeZone: env.REPORTING_TIME_ZONE ?? 'Asia/Kolkata',
  };
}
