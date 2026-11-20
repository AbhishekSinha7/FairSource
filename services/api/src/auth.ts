// API keys: "Authorization: Bearer fs_<8-char prefix>_<secret>". The prefix finds
// apiKeys/{prefix}; the SHA-256 of the whole key must match the stored hash.
// Key records are cached for 60 s, so a revoked key stops working within 60 s.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiKeyRecord, BuyerRecord, Store } from './ports.js';

const KEY = /^fs_([a-z0-9]{8})_([A-Za-z0-9]{16,128})$/;

export interface Caller {
  key: ApiKeyRecord;
  buyer: BuyerRecord;
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export class KeyAuth {
  private keys = new Map<string, { at: number; rec: ApiKeyRecord | null }>();
  private buyers = new Map<string, { at: number; rec: BuyerRecord | null }>();
  private touched = new Map<string, number>();

  constructor(
    private store: Store,
    private ttlMs: number,
    private now: () => Date,
  ) {}

  async authenticate(header: string | undefined): Promise<Caller | null> {
    const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const m = token?.match(KEY);
    if (!token || !m) return null;
    const prefix = m[1]!;
    const t = this.now().getTime();

    let k = this.keys.get(prefix);
    if (!k || t - k.at > this.ttlMs) {
      k = { at: t, rec: await this.store.getApiKey(prefix) };
      this.keys.set(prefix, k);
    }
    const rec = k.rec;
    if (!rec || rec.revokedAt) return null;
    const a = Buffer.from(hashKey(token), 'hex');
    const b = Buffer.from(rec.hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    // Buyer status and quota change more often than keys: cache briefly.
    let bu = this.buyers.get(rec.buyerId);
    if (!bu || t - bu.at > 10_000) {
      bu = { at: t, rec: await this.store.getBuyer(rec.buyerId) };
      this.buyers.set(rec.buyerId, bu);
    }
    if (!bu.rec) return null;

    if (t - (this.touched.get(prefix) ?? 0) > 60_000) {
      this.touched.set(prefix, t);
      this.store.touchApiKey(prefix, this.now()).catch(() => undefined); // "Last used" on the keys page
    }
    return { key: rec, buyer: bu.rec };
  }

  /**
   * The web dashboard's Playground acts as one of the buyer's own keys without
   * holding the secret (only its hash is stored). Only reachable with the
   * internal token; the key must belong to the buyer and not be revoked.
   */
  async authenticateAs(buyerId: string, prefix: string): Promise<Caller | null> {
    const rec = await this.store.getApiKey(prefix);
    if (!rec || rec.revokedAt || rec.buyerId !== buyerId) return null;
    const buyer = await this.store.getBuyer(buyerId);
    return buyer ? { key: rec, buyer } : null;
  }

  /** After metering, so the next quota check in this instance sees the new total. */
  noteUsage(buyerId: string, tokens: number, month: string) {
    const bu = this.buyers.get(buyerId);
    if (!bu?.rec) return;
    const used = bu.rec.usageMonth === month ? bu.rec.usedTokensThisMonth : 0;
    bu.rec = { ...bu.rec, usedTokensThisMonth: used + tokens, usageMonth: month };
  }
}

/** 60 requests per minute per key (per instance). */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private perMinute: number,
    private now: () => Date,
  ) {}

  take(key: string): boolean {
    const t = this.now().getTime();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

export function quotaLeft(buyer: BuyerRecord, month: string): number {
  const used = buyer.usageMonth === month ? buyer.usedTokensThisMonth : 0;
  return buyer.monthlyQuotaTokens - used;
}
