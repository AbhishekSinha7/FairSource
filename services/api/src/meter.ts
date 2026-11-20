// Metering: one ledger row per document served (so payouts never split a row),
// priced with the publisher's licence at the time of use.
//   amount_micros = ceil(tokens / 1000 × pricePer1kTokensMicros)

import { randomUUID } from 'node:crypto';
import type { Licence } from '@fairsource/shared';
import type { DocumentUse, Endpoint, LedgerRow, PublisherView, UsageCounters } from './ports.js';

export interface Served {
  documentId: string;
  title: string;
  documentVersion: number;
  publisherId: string;
  language: string;
  chunkIds: string[];
  tokens: number;
}

export interface MeterContext {
  buyerId: string;
  buyerName: string;
  keyPrefix: string;
  endpoint: Endpoint;
  requestId: string;
  now: Date;
  timeZone: string;
}

export const DEFAULT_SHARE_PCT = 75;

export function localDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function meter(served: Served[], licences: Map<string, Licence>, publishers: Map<string, PublisherView>, ctx: MeterContext) {
  const byDoc = new Map<string, Served>();
  for (const s of served) {
    const cur = byDoc.get(s.documentId);
    if (cur) {
      cur.chunkIds.push(...s.chunkIds);
      cur.tokens += s.tokens;
    } else byDoc.set(s.documentId, { ...s, chunkIds: [...s.chunkIds] });
  }

  const rows: LedgerRow[] = [];
  const earnings = new Map<string, { tokens: number; grossMicros: number; shareMicros: number }>();
  const languages: Record<string, number> = {};
  const documents: DocumentUse[] = [];
  for (const s of byDoc.values()) {
    const lic = licences.get(s.publisherId)!;
    const amount = Math.ceil((s.tokens * lic.pricePer1kTokensMicros) / 1000);
    const eventId = randomUUID();
    rows.push({
      event_id: eventId,
      ts: ctx.now.toISOString(),
      buyer_id: ctx.buyerId,
      api_key_prefix: ctx.keyPrefix,
      endpoint: ctx.endpoint,
      publisher_id: s.publisherId,
      document_id: s.documentId,
      document_version: s.documentVersion,
      chunk_ids: s.chunkIds,
      licence_id: lic.id,
      licence_version: lic.version,
      tokens_served: s.tokens,
      amount_micros: amount,
      request_id: ctx.requestId,
    });
    const sharePct = publishers.get(s.publisherId)?.revenueSharePct ?? DEFAULT_SHARE_PCT;
    const e = earnings.get(s.publisherId) ?? { tokens: 0, grossMicros: 0, shareMicros: 0 };
    e.tokens += s.tokens;
    e.grossMicros += amount;
    e.shareMicros = Math.floor((e.grossMicros * sharePct) / 100);
    earnings.set(s.publisherId, e);
    documents.push({
      eventId,
      documentId: s.documentId,
      publisherId: s.publisherId,
      title: s.title,
      language: s.language,
      tokens: s.tokens,
      grossMicros: amount,
      shareMicros: Math.floor((amount * sharePct) / 100),
    });
    languages[s.language] = (languages[s.language] ?? 0) + s.tokens;
  }

  const date = localDate(ctx.now, ctx.timeZone);
  const counters: UsageCounters = {
    buyerId: ctx.buyerId,
    buyerName: ctx.buyerName,
    ts: ctx.now,
    documents,
    date,
    month: date.slice(0, 7),
    endpoint: ctx.endpoint,
    tokens: rows.reduce((n, r) => n + r.tokens_served, 0),
    amountMicros: rows.reduce((n, r) => n + r.amount_micros, 0),
    languages,
    earnings: [...earnings].map(([publisherId, e]) => ({ publisherId, ...e })),
  };
  return { rows, counters };
}
