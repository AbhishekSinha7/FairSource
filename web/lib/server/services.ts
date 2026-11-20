// Calls from the dashboard's server to ingest and the API.
//  - ingest is private (Cloud Run IAM): requests carry a Google ID token for its URL.
//  - the API's internal routes take the shared INTERNAL_TOKEN.

import { GoogleAuth } from 'google-auth-library';
import { API_URL, INGEST_URL, INTERNAL_TOKEN } from './env';

const auth = new GoogleAuth();

async function ingestHeaders(): Promise<Record<string, string>> {
  if (/^http:\/\/(localhost|127\.0\.0\.1)/.test(INGEST_URL)) return {}; // local ingest has no IAM
  const client = await auth.getIdTokenClient(INGEST_URL);
  const h = await client.getRequestHeaders();
  return Object.fromEntries(Object.entries(h as unknown as Record<string, string>));
}

export interface ServiceResult<T> {
  ok: boolean;
  status: number;
  body: T;
}

async function call<T>(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<ServiceResult<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as T };
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError';
    return { ok: false, status: timeout ? 504 : 502, body: { error: timeout ? 'timeout' : 'unreachable' } as T };
  }
}

export async function ingest<T>(path: string, body: unknown, timeoutMs = 55_000) {
  return call<T>(`${INGEST_URL}${path}`, await ingestHeaders(), body, timeoutMs);
}

export async function apiInternal<T>(path: string, body: unknown, extra: Record<string, string> = {}, timeoutMs = 30_000) {
  return call<T>(`${API_URL}${path}`, { 'x-internal-token': INTERNAL_TOKEN, ...extra }, body, timeoutMs);
}

/** Re-stamp chunk rights after an opt-out or licence change (search is already correct without it). */
export async function restamp(target: { documentId: string } | { publisherId: string }) {
  const r = await apiInternal<{ documents?: number }>('/internal/restamp', target);
  if (!r.ok) console.error(JSON.stringify({ severity: 'WARNING', event: 'restamp_failed', target, status: r.status }));
  return r.ok;
}
