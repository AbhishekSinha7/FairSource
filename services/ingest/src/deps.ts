import type { IngestConfig } from './config.js';
import type { Fetcher } from './http.js';
import type { Blobs, Bus, Store } from './ports.js';
import type { RobotsCache } from './robots.js';

export interface Deps {
  cfg: IngestConfig;
  store: Store;
  blobs: Blobs;
  bus: Bus;
  fetcher: Fetcher;
  robots: RobotsCache;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
}

/** One structured JSON line per event, as Cloud Logging expects. */
export const jsonLog = (entry: Record<string, unknown>) =>
  console.log(JSON.stringify({ severity: entry.severity ?? 'INFO', service: 'ingest', ...entry }));
