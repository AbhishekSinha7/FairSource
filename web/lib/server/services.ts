// Calls from the dashboard's server to ingest and the API.
//  - ingest is private (Cloud Run IAM): requests carry a Google ID token for its URL.
//  - the API's internal routes take the shared INTERNAL_TOKEN.

import { execSync } from 'node:child_process';
import { GoogleAuth } from 'google-auth-library';
import { API_URL, INGEST_URL, INTERNAL_TOKEN } from './env';

const auth = new GoogleAuth();

let cliToken: { value: string; at: number } | null = null;

/**
 * On Cloud Run the service account mints an ID token for ingest's URL. On a developer
 * PC (personal gcloud login) the library can't, so fall back to the gcloud CLI, whose
 * user identity tokens Cloud Run also accepts (the user needs run.invoker, which owners have).
 */
function gcloudIdentityToken(): string {
  if (cliToken && Date.now() - cliToken.at < 30 * 60 * 1000) return cliToken.value;
  const value = execSync('gcloud auth print-identity-token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' }).trim();
  cliToken = { value, at: Date.now() };
  return value;
}

async function ingestHeaders(): Promise<Record<string, string>> {
  if (/^http:\/\/(localhost|127\.0\.0\.1)/.test(INGEST_URL)) return {}; // local ingest has no IAM
  try {
    const client = await auth.getIdTokenClient(INGEST_URL);
    const h = await client.getRequestHeaders();
    return Object.fromEntries(Object.entries(h as unknown as Record<string, string>));
  } catch {
    return { authorization: `Bearer ${gcloudIdentityToken()}` };
  }
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
