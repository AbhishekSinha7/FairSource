'use server';

// Server actions: every write the dashboard makes. Each one checks the signed-in
// organisation first; Firestore security rules deny all client writes.
// Only used in live mode; in demo mode the views update locally.

import { createHash, randomInt } from 'node:crypto';
import { newSource, type Territory, type Use } from '@fairsource/shared';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/server/admin';
import { requireSession } from '@/lib/server/session';
import { apiInternal, ingest, restamp } from '@/lib/server/services';

export type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; message: string };

const fail = (message: string): ActionResult<never> => ({ ok: false, message });
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ALNUM_MIXED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const randomString = (n: number, alphabet: string) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');

/** Same rule as `servable` in the shared schema and the API's documentServable(). */
function documentServable(d: Record<string, unknown>, optOut: boolean): boolean {
  return d.status === 'done' && Number(d.version ?? 0) > 0 && !optOut && !d.duplicateOf && !d.needsReview && (d.safety ?? 'ok') === 'ok';
}

// ---------------------------------------------------------------- content

export async function setOptOut(documentId: string, optOut: boolean): Promise<ActionResult<{ servable: boolean }>> {
  const s = await requireSession('publisher');
  const ref = adminDb().collection('documents').doc(documentId);
  const snap = await ref.get();
  if (!snap.exists || snap.get('publisherId') !== s.orgId) return fail('Article not found.');
  if (snap.get('status') === 'withdrawn') return fail('This article was removed from your site and is no longer served.');
  const servable = documentServable(snap.data()!, optOut);
  await ref.update({ optOut, servable });
  // Search already respects the change on the next request; re-stamping keeps the index pre-filter in step.
  await restamp({ documentId });
  return { ok: true, data: { servable } };
}

// ---------------------------------------------------------------- licence

export async function saveLicence(terms: { uses: Use[]; territories: Territory[]; pricePer1k: number }): Promise<ActionResult<{ version: number }>> {
  const s = await requireSession('publisher');
  const uses = [...new Set(terms.uses)].filter((u): u is Use => u === 'rag' || u === 'training');
  const territories = [...new Set(terms.territories)].filter((t): t is Territory => t === 'IN' || t === 'GLOBAL');
  if (!(terms.pricePer1k > 0 && terms.pricePer1k <= 1)) return fail('Enter a price above $0 and up to $1 per 1,000 tokens.');
  const micros = Math.round(terms.pricePer1k * 1e6);

  const db = adminDb();
  const col = db.collection('licences');
  const version = await db.runTransaction(async (tx) => {
    const all = await tx.get(col.where('publisherId', '==', s.orgId));
    const next = Math.max(0, ...all.docs.map((d) => Number(d.get('version') ?? 0))) + 1;
    for (const d of all.docs) if (d.get('active')) tx.update(d.ref, { active: false });
    tx.create(col.doc(`lic_${s.orgId}_v${next}`), {
      publisherId: s.orgId,
      uses,
      territories,
      pricePer1kTokensMicros: micros,
      active: true,
      version: next,
      createdAt: new Date(),
      createdBy: s.uid,
    });
    return next;
  });
  await restamp({ publisherId: s.orgId });
  return { ok: true, data: { version } };
}

// ---------------------------------------------------------------- sources

interface Discovery {
  found: boolean;
  url?: string;
  method?: 'manual' | 'link_rel' | 'well_known_path' | 'robots_txt';
  title?: string;
  items?: number;
  message?: string;
}
interface RunSummary {
  result: string;
  counts?: Record<string, number>;
  backfill?: { status: string; discovered: number; queued: number };
  error?: string;
}

export async function connectSource(type: 'rss' | 'sitemap', address: string, consent: boolean): Promise<ActionResult<{ message: string }>> {
  const s = await requireSession('publisher');
  if (!consent) return fail('Please confirm you own or control this content.');
  const d = await ingest<Discovery>('/internal/discover', { url: address, type }, 30_000);
  if (!d.ok || !d.body.found || !d.body.url) return fail(d.body.message ?? `No ${type === 'rss' ? 'feed' : 'sitemap'} found at that address.`);

  const db = adminDb();
  const dupe = await db.collection('sources').where('publisherId', '==', s.orgId).where('url', '==', d.body.url).limit(1).get();
  if (!dupe.empty) return fail('That source is already connected.');

  const id = `src_${randomString(10, ALNUM)}`;
  const host = new URL(d.body.url).hostname.replace(/^www\./, '');
  await db.collection('sources').doc(id).set(
    newSource({ id, publisherId: s.orgId, type, name: d.body.title || host, url: d.body.url, discoveredFrom: d.body.method, consentAt: new Date() }),
  );
  // Start the backfill now; anything left continues on the 5-minute schedule.
  const run = await ingest<RunSummary>('/internal/run', { sourceId: id });
  const found = d.body.method === 'manual' ? '' : ` Found ${type === 'rss' ? 'the feed' : 'the sitemap'} at ${d.body.url.replace(/^https?:\/\//, '')}.`;
  const progress = run.ok && run.body.backfill ? ` Imported ${run.body.backfill.queued} of ${run.body.backfill.discovered} posts so far.` : ' Importing your existing posts now.';
  return { ok: true, data: { message: `Connected.${found}${progress}` } };
}

export async function syncSource(sourceId: string): Promise<ActionResult<{ note: string }>> {
  const s = await requireSession('publisher');
  const ref = adminDb().collection('sources').doc(sourceId);
  const snap = await ref.get();
  if (!snap.exists || snap.get('publisherId') !== s.orgId) return fail('Source not found.');
  await ref.update({ syncRequestedAt: new Date() });
  const run = await ingest<RunSummary>('/internal/run', { sourceId, mode: 'manual' });
  if (!run.ok) return { ok: true, data: { note: run.status === 504 ? 'Still running' : 'Queued' } };
  if (run.body.result === 'busy') return { ok: true, data: { note: 'Already running' } };
  if (run.body.result === 'error') return fail(run.body.error ?? 'The source could not be fetched.');
  const c = run.body.counts ?? {};
  const parts = [c.new && `${c.new} new`, (c.changed ?? 0) + (c.restored ?? 0) > 0 && `${(c.changed ?? 0) + (c.restored ?? 0)} updated`].filter(Boolean);
  return { ok: true, data: { note: parts.length ? parts.join(' · ') : 'No changes' } };
}

/** A 15-minute signed URL; the browser uploads straight to Cloud Storage and Eventarc starts processing. */
export async function requestUpload(file: { name: string; type: string; size: number }): Promise<ActionResult<{ uploadUrl: string }>> {
  const s = await requireSession('publisher');
  const db = adminDb();
  const q = await db.collection('sources').where('publisherId', '==', s.orgId).where('type', '==', 'upload').limit(1).get();
  let sourceId = q.docs[0]?.id;
  if (!sourceId) {
    sourceId = `src_${randomString(10, ALNUM)}`;
    await db.collection('sources').doc(sourceId).set(newSource({ id: sourceId, publisherId: s.orgId, type: 'upload', name: 'Uploads', url: null, consentAt: new Date() }));
  }
  const r = await ingest<{ uploadUrl?: string; message?: string }>('/uploads/sign', { publisherId: s.orgId, sourceId, filename: file.name, contentType: file.type, size: file.size }, 20_000);
  if (!r.ok || !r.body.uploadUrl) return fail(r.body.message ?? 'Upload could not be started.');
  return { ok: true, data: { uploadUrl: r.body.uploadUrl } };
}

// ------------------------------------------------------------------- keys

type Scope = 'search' | 'answer' | 'documents';

export async function createKey(name: string, scopes: Scope[]): Promise<ActionResult<{ key: string; prefix: string }>> {
  const s = await requireSession('buyer');
  const clean = name.trim().slice(0, 80);
  const allowed = scopes.filter((x): x is Scope => ['search', 'answer', 'documents'].includes(x));
  if (!clean) return fail('Give the key a name.');
  if (!allowed.length) return fail('Pick at least one scope.');
  const col = adminDb().collection('apiKeys');
  for (let attempt = 0; attempt < 5; attempt++) {
    const prefix = randomString(8, ALNUM);
    const key = `fs_${prefix}_${randomString(32, ALNUM_MIXED)}`;
    try {
      await col.doc(prefix).create({
        buyerId: s.orgId,
        name: clean,
        hash: createHash('sha256').update(key).digest('hex'),
        scopes: allowed,
        createdAt: new Date(),
        createdBy: s.uid,
        lastUsedAt: null,
        revokedAt: null,
      });
      return { ok: true, data: { key, prefix } }; // shown once, never stored
    } catch (e) {
      if ((e as { code?: number }).code !== 6) throw e; // 6 = ALREADY_EXISTS: try another prefix
    }
  }
  return fail('Could not create a key. Please try again.');
}

export async function revokeKey(prefix: string): Promise<ActionResult<null>> {
  const s = await requireSession('buyer');
  const ref = adminDb().collection('apiKeys').doc(prefix);
  const snap = await ref.get();
  if (!snap.exists || snap.get('buyerId') !== s.orgId) return fail('Key not found.');
  await ref.update({ revokedAt: FieldValue.serverTimestamp() });
  return { ok: true, data: null };
}

// ------------------------------------------------------------- playground

/** Calls the real API as one of the buyer's keys (metered like any other call). */
export async function playgroundCall(mode: 'search' | 'answer', keyPrefix: string, body: Record<string, unknown>): Promise<ActionResult<Record<string, unknown>>> {
  const s = await requireSession('buyer');
  if (!/^[a-z0-9]{8}$/.test(keyPrefix)) return fail('Pick one of your keys.');
  const started = Date.now();
  const r = await apiInternal<Record<string, unknown>>(`/v1/${mode}`, body, { 'x-fs-buyer': s.orgId, 'x-fs-key-prefix': keyPrefix }, 60_000);
  if (!r.ok) return fail(String(r.body.message ?? r.body.error ?? `The API returned ${r.status}.`));
  return { ok: true, data: { ...r.body, latencyMs: Date.now() - started } };
}
