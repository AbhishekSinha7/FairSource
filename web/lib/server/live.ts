// Real data for the signed-in organisation, read with the Admin SDK.
// Every function returns the same shape as its demo counterpart in lib/data.ts.

import { licenceTag, type DocumentRecord, type Licence, type Source } from '@fairsource/shared';
import type { LicenceVersionView } from '../licence';
import type { ContentRow, KeyView, SourceView, UseEvent } from '../mock';
import { adminDb, revive } from './admin';
import { REPORTING_TIME_ZONE } from './env';
import { languageName, type Session } from './session';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const localDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: REPORTING_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const localTime = (d: Date, withSeconds = true) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: REPORTING_TIME_ZONE, hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false }).format(d);
const dayMonth = (d: Date) => {
  const [, m, day] = localDate(d).split('-').map(Number);
  return `${day} ${MONTHS[(m ?? 1) - 1]}`;
};
const daysAgo = (n: number) => localDate(new Date(Date.now() - n * 86_400_000));

export function relative(d: Date | null | undefined): string {
  if (!d) return 'Never';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (localDate(d) === localDate(new Date())) return `Today, ${localTime(d, false)}`;
  if (localDate(d) === daysAgo(1)) return 'Yesterday';
  return dayMonth(d);
}

async function activeLicence(publisherId: string): Promise<Licence | null> {
  const q = await adminDb().collection('licences').where('publisherId', '==', publisherId).where('active', '==', true).get();
  const all = q.docs.map((s) => revive<Licence>({ ...s.data(), id: s.id }));
  return all.sort((a, b) => b.version - a.version)[0] ?? null;
}

async function publisherDoc(id: string) {
  return (await adminDb().collection('publishers').doc(id).get()).data() ?? {};
}

// --------------------------------------------------------------- publisher

export async function earnings(s: Session) {
  const db = adminDb();
  const pub = s.orgId;
  const today = localDate(new Date());
  const month = today.slice(0, 7);
  const from = daysAgo(29);
  const [days, lic, p, top, usedCount, totalCount, recent] = await Promise.all([
    db.collection('earnings').where('publisherId', '==', pub).where('date', '>=', from).orderBy('date').get(),
    activeLicence(pub),
    publisherDoc(pub),
    db.collection('documentUsage').where('publisherId', '==', pub).where('month', '==', month).orderBy('tokens', 'desc').limit(5).get(),
    db.collection('documentUsage').where('publisherId', '==', pub).where('month', '==', month).count().get(),
    db.collection('documents').where('publisherId', '==', pub).count().get(),
    db.collection('publishers').doc(pub).collection('recentUses').orderBy('ts', 'desc').limit(5).get(),
  ]);

  const byDate = new Map(days.docs.map((d) => [String(d.get('date')), d.data()]));
  const daily = Array.from({ length: 30 }, (_, i) => {
    const date = daysAgo(29 - i);
    return { date, value: Number(byDate.get(date)?.publisherShareMicros ?? 0) / 1e6 };
  });
  const monthDays = [...byDate.entries()].filter(([d]) => d.startsWith(month)).map(([, v]) => v);
  const sum = (k: string) => monthDays.reduce((n, v) => n + Number(v[k] ?? 0), 0);
  const t = byDate.get(today) ?? {};

  const recentUses: UseEvent[] = recent.docs.map((d) => {
    const r = revive<{ ts: Date; title: string; buyer: string; endpoint: string; tokens: number }>(d.data());
    return { id: d.id, time: localTime(r.ts), title: r.title, buyer: r.buyer, endpoint: r.endpoint === 'mcp' ? 'MCP' : (r.endpoint as UseEvent['endpoint']), tokens: r.tokens };
  });

  return {
    today: { shareUSD: Number(t.publisherShareMicros ?? 0) / 1e6, tokens: Number(t.tokensServed ?? 0), uses: Number(t.uses ?? 0) },
    month: {
      gross: sum('grossMicros') / 1e6,
      share: sum('publisherShareMicros') / 1e6,
      tokens: sum('tokensServed'),
      articlesUsed: usedCount.data().count,
      articlesTotal: totalCount.data().count,
    },
    daily,
    recentUses,
    topArticles: top.docs.map((d) => ({ title: String(d.get('title')), language: languageName(String(d.get('language'))), uses: Number(d.get('uses')), tokens: Number(d.get('tokens')) })),
    payout: { date: `3 ${MONTHS[(Number(month.slice(5, 7)) % 12)]}`, carried: 0, account: p.payout?.provider === 'razorpay' ? 'Razorpay Route · test mode' : 'Stripe Connect · test mode', minimum: 10 },
    pricePer1k: (lic?.pricePer1kTokensMicros ?? 0) / 1e6,
    share: Number(p.revenueSharePct ?? 75) / 100,
    licenceVersion: lic?.version ?? 0,
  };
}

function sourceView(src: Source): SourceView {
  const type = ({ rss: 'RSS', sitemap: 'Sitemap', upload: 'Upload', cms: 'CMS' } as const)[src.type];
  const bf = src.backfill;
  const backfilling = bf && (bf.status === 'pending' || bf.status === 'running');
  return {
    id: src.id,
    name: src.name,
    detail: src.url ? src.url.replace(/^https?:\/\//, '') : 'Uploaded from the dashboard',
    type,
    schedule: src.type === 'upload' ? 'On upload' : `Every ${src.scheduleMins} min`,
    lastRun: relative(src.lastFetchedAt),
    items: src.itemCount ?? 0,
    status: src.syncRequestedAt ? 'syncing' : backfilling ? 'backfilling' : src.status === 'error' ? 'error' : 'healthy',
    backfill: backfilling ? { done: bf.queued, total: Math.max(bf.discovered, bf.queued, 1) } : undefined,
    lastSyncNote: src.status === 'error' ? (src.lastError ?? undefined) : undefined,
  };
}

/** The processing panel, built from the latest processed document's real fields. */
function stepsFor(d: DocumentRecord, lic: Licence | null) {
  const lang = `${languageName(d.language)} (${d.language}) · ${d.script === 'Deva' ? 'Devanagari' : d.script === 'Latn' ? 'Latin' : d.script}`;
  return [
    { title: 'Fetched and stored', detail: `Raw file saved · content hash ${d.contentHash.slice(0, 4)}…${d.contentHash.slice(-2)}`, ok: true },
    { title: 'Text extracted', detail: d.sourceUrl ? 'Article text from the page' : 'Gemini Pro OCR', ok: true },
    { title: 'Cleaned and structured', detail: `Gemini Flash · title, date${d.author ? ', author' : ''}, ${d.topics?.length ?? 0} topics`, ok: true },
    { title: d.needsReview ? 'Language needs review' : 'Language detected', detail: `${lang} · ${d.needsReview ? 'checks disagree' : 'language check agrees'}`, ok: !d.needsReview },
    { title: d.duplicateOf ? 'Duplicate found' : 'Duplicate check passed', detail: d.duplicateOf ? 'Same article at another URL · not served twice' : 'Gemma · no matching story at another URL', ok: !d.duplicateOf },
    { title: d.safety === 'ok' ? 'Safety check passed' : 'Not served: safety', detail: `Gemma · label: ${d.safety}`, ok: d.safety === 'ok' },
    { title: `${d.chunkCount} chunks embedded`, detail: 'Gemini embeddings · 768 dimensions', ok: d.chunkCount > 0 },
    d.servable
      ? { title: 'Licensed and searchable', detail: lic ? `Licence v${lic.version} · ${lic.uses.join(' + ').toUpperCase()} · ${lic.territories.map((x) => (x === 'IN' ? 'India' : 'global')).join(' and ')}` : 'No active licence', ok: !!lic }
      : { title: 'Not served yet', detail: d.optOut ? 'Opted out' : 'See the checks above', ok: false },
  ];
}

export async function sources(s: Session) {
  const db = adminDb();
  const [q, latest, lic] = await Promise.all([
    db.collection('sources').where('publisherId', '==', s.orgId).get(),
    db.collection('documents').where('publisherId', '==', s.orgId).orderBy('processedAt', 'desc').limit(1).get(),
    activeLicence(s.orgId),
  ]);
  const list = q.docs.map((d) => sourceView(revive<Source>({ ...d.data(), id: d.id }))).sort((a, b) => a.name.localeCompare(b.name));
  list.push({ id: 'src_cms', name: 'WordPress or Ghost', detail: 'Connect your CMS directly', type: 'CMS', schedule: '—', lastRun: '—', items: null, status: 'soon' });
  const doc = latest.docs[0] ? revive<DocumentRecord>({ ...latest.docs[0].data(), id: latest.docs[0].id }) : null;
  return {
    sources: list,
    steps: doc ? stepsFor(doc, lic) : [],
    latestItem: doc ? { name: doc.title, detail: `version ${doc.version} · processed ${relative(doc.processedAt)}` } : { name: 'Nothing processed yet', detail: 'Connect a feed or upload a file' },
    uploadSourceId: q.docs.find((d) => d.get('type') === 'upload')?.id ?? null,
  };
}

export async function licence(s: Session) {
  const db = adminDb();
  const month = localDate(new Date()).slice(0, 7);
  const [q, p, days] = await Promise.all([
    db.collection('licences').where('publisherId', '==', s.orgId).orderBy('version', 'desc').limit(10).get(),
    publisherDoc(s.orgId),
    db.collection('earnings').where('publisherId', '==', s.orgId).where('date', '>=', `${month}-01`).get(),
  ]);
  const versions: LicenceVersionView[] = q.docs.map((d) => {
    const l = revive<Licence>(d.data());
    return { version: l.version, uses: l.uses, territories: l.territories, pricePer1k: l.pricePer1kTokensMicros / 1e6, createdAt: localDate(l.createdAt) };
  });
  return {
    versions,
    share: Number(p.revenueSharePct ?? 75) / 100,
    monthTokens: days.docs.reduce((n, d) => n + Number(d.get('tokensServed') ?? 0), 0),
    publisherName: String(p.name ?? s.orgId),
  };
}

const TYPE: Record<string, ContentRow['type']> = { news: 'News', opinion: 'Opinion', feature: 'Feature', book: 'Book', other: 'Other' };

export async function content(s: Session) {
  const db = adminDb();
  const month = localDate(new Date()).slice(0, 7);
  const base = db.collection('documents').where('publisherId', '==', s.orgId);
  const [docs, srcs, uses, total, servable, review] = await Promise.all([
    base.orderBy('firstSeenAt', 'desc').limit(200).get(),
    db.collection('sources').where('publisherId', '==', s.orgId).get(),
    db.collection('documentUsage').where('publisherId', '==', s.orgId).where('month', '==', month).get(),
    base.count().get(),
    base.where('servable', '==', true).count().get(),
    base.where('needsReview', '==', true).count().get(),
  ]);
  const sourceType = new Map(srcs.docs.map((d) => [d.id, String(d.get('type'))]));
  const useCount = new Map(uses.docs.map((d) => [String(d.get('documentId')), Number(d.get('uses') ?? 0)]));

  const rows: ContentRow[] = docs.docs.map((snap) => {
    const d = revive<DocumentRecord>({ ...snap.data(), id: snap.id });
    const upload = d.identityKey?.startsWith('upload:');
    const via: ContentRow['via'] = upload ? (d.sourceUrl ? 'Upload' : 'Scan') : sourceType.get(d.sourceId) === 'sitemap' ? 'Sitemap' : 'RSS';
    const detail =
      d.status === 'withdrawn'
        ? `removed from your site${d.withdrawnAt ? ` on ${dayMonth(d.withdrawnAt)}` : ''}`
        : d.status === 'queued' || d.status === 'processing'
          ? 'processing'
          : d.status === 'failed'
            ? (d.processingError ?? 'processing failed')
            : d.duplicateOf
              ? 'same story at another URL'
              : d.needsReview
                ? 'language checks disagree'
                : `${d.chunkCount ?? 0} chunks`;
    return {
      id: d.id,
      title: d.title,
      via,
      detail,
      language: (languageName(d.language ?? '') || 'English') as ContentRow['language'],
      type: TYPE[d.contentType ?? 'other'] ?? 'Other',
      published: d.publishedAt ? dayMonth(d.publishedAt) : '—',
      uses: useCount.get(d.id) ?? 0,
      version: d.version ?? 0,
      status: d.status,
      optOut: !!d.optOut,
      duplicateOf: d.duplicateOf ?? null,
      needsReview: !!d.needsReview,
      safety: d.safety ?? 'ok',
    };
  });
  return { rows, totals: { documents: total.data().count, servable: servable.data().count, needsReview: review.data().count } };
}

// ------------------------------------------------------------------- buyer

export async function keys(s: Session): Promise<{ keys: KeyView[] }> {
  const q = await adminDb().collection('apiKeys').where('buyerId', '==', s.orgId).get();
  type KeyDoc = { name: string; scopes: KeyView['scopes']; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null };
  const list = q.docs
    .map((d) => ({ id: d.id, ...revive<KeyDoc>(d.data()) }))
    .sort((a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt) || b.createdAt.getTime() - a.createdAt.getTime());
  return {
    keys: list.map((k) => ({ prefix: k.id, name: k.name, scopes: k.scopes, created: dayMonth(k.createdAt), lastUsed: relative(k.lastUsedAt), revoked: !!k.revokedAt })),
  };
}

export async function playground(s: Session) {
  const { keys: all } = await keys(s);
  return { keys: all.filter((k) => !k.revoked), corpus: [], pricePer1k: 0 };
}

export async function usage(s: Session) {
  const db = adminDb();
  const today = localDate(new Date());
  const month = today.slice(0, 7);
  const [days, buyer] = await Promise.all([
    db.collection('buyerUsage').where('buyerId', '==', s.orgId).where('date', '>=', `${month}-01`).where('date', '<=', today).orderBy('date').get(),
    db.collection('buyers').doc(s.orgId).get(),
  ]);
  const rows = days.docs.map((d) => d.data());
  const add = (into: Record<string, number>, from: Record<string, number> | undefined) => {
    for (const [k, v] of Object.entries(from ?? {})) into[k] = (into[k] ?? 0) + Number(v);
  };
  const endpoints: Record<string, number> = {};
  const languages: Record<string, number> = {};
  const pubs: Record<string, { tokens: number; spendMicros: number }> = {};
  for (const r of rows) {
    add(endpoints, r.endpoints);
    add(languages, r.languages);
    for (const [p, v] of Object.entries((r.publishers ?? {}) as Record<string, { tokens: number; spendMicros: number }>)) {
      const cur = (pubs[p] ??= { tokens: 0, spendMicros: 0 });
      cur.tokens += Number(v.tokens ?? 0);
      cur.spendMicros += Number(v.spendMicros ?? 0);
    }
  }
  const pubIds = Object.keys(pubs);
  const [pubDocs, lics] = await Promise.all([
    pubIds.length ? db.getAll(...pubIds.map((id) => db.collection('publishers').doc(id))) : Promise.resolve([]),
    Promise.all(pubIds.map((id) => activeLicence(id))),
  ]);
  const byDate = new Map(rows.map((r) => [String(r.date), Number(r.tokens ?? 0)]));
  const dayCount = Number(today.slice(8, 10));
  const label: Record<string, string> = { search: '/v1/search', answer: '/v1/answer', document: '/v1/documents', mcp: 'mcp' };
  const nextMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));

  return {
    usage: {
      periodLabel: `${new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(new Date(`${month}-15`))} so far`,
      nextInvoice: `1 ${MONTHS[nextMonth.getUTCMonth()]}`,
      requests: rows.reduce((n, r) => n + Number(r.requests ?? 0), 0),
      rateLimited: 0,
      daily: Array.from({ length: dayCount }, (_, i) => {
        const date = `${month}-${String(i + 1).padStart(2, '0')}`;
        return { date, tokens: byDate.get(date) ?? 0 };
      }),
      byEndpoint: Object.entries(endpoints).map(([k, tokens]) => ({ label: label[k] ?? k, tokens })).sort((a, b) => b.tokens - a.tokens),
      byLanguage: Object.entries(languages).map(([k, tokens]) => ({ label: languageName(k), tokens })).sort((a, b) => b.tokens - a.tokens),
      publishers: pubIds
        .map((id, i) => {
          const l = lics[i];
          return {
            name: String(pubDocs.find((d) => d.id === id)?.get('name') ?? id),
            licence: l ? licenceTag(l) : '—',
            pricePer1k: (l?.pricePer1kTokensMicros ?? 0) / 1e6,
            tokens: pubs[id]!.tokens,
          };
        })
        .sort((a, b) => b.tokens - a.tokens),
    },
    quota: Number(buyer.get('monthlyQuotaTokens') ?? 0),
  };
}
