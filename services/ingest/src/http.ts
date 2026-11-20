// Polite HTTP: one request at a time per host, at most one per second,
// a User-Agent naming FairSource, a timeout and a size cap.

import type { IngestConfig } from './config.js';

export class FetchError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network' | 'too_large',
    message: string,
  ) {
    super(message);
  }
}

export interface FetchResult {
  status: number;
  /** Final URL after redirects. */
  url: string;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
  bytes: Uint8Array;
  text(): string;
}

export interface GetOptions {
  method?: 'GET' | 'HEAD';
  etag?: string | null;
  lastModified?: string | null;
  accept?: string;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

type FetcherConfig = Pick<IngestConfig, 'userAgent' | 'minIntervalMs' | 'maxBytes' | 'timeoutMs'>;

export class Fetcher {
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private cfg: FetcherConfig,
    private fetchFn: FetchFn = (url, init) => fetch(url, init),
  ) {}

  get(url: string, opts: GetOptions = {}): Promise<FetchResult> {
    const host = new URL(url).host;
    const prev = this.chains.get(host) ?? Promise.resolve();
    const run = prev.then(() => this.spaced(url, opts));
    this.chains.set(
      host,
      run.catch(() => undefined),
    );
    return run;
  }

  private async spaced(url: string, opts: GetOptions): Promise<FetchResult> {
    const started = Date.now();
    try {
      return await this.once(url, opts);
    } finally {
      const wait = this.cfg.minIntervalMs - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  private async once(url: string, opts: GetOptions): Promise<FetchResult> {
    const headers: Record<string, string> = { 'user-agent': this.cfg.userAgent, accept: opts.accept ?? '*/*' };
    if (opts.etag) headers['if-none-match'] = opts.etag;
    if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: opts.method ?? 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      const name = (e as Error).name;
      throw new FetchError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', `${url}: ${(e as Error).message}`);
    }

    const bytes = opts.method === 'HEAD' ? new Uint8Array() : await readCapped(res, this.cfg.maxBytes, url);
    return {
      status: res.status,
      url: res.url || url,
      contentType: (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase(),
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      bytes,
      text: () => new TextDecoder().decode(bytes),
    };
  }
}

async function readCapped(res: Response, max: number, url: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) {
    await res.body?.cancel();
    throw new FetchError('too_large', `${url}: ${declared} bytes is over the ${max} byte limit`);
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new FetchError('too_large', `${url}: over the ${max} byte limit`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
