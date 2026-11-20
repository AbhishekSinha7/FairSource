// The one place pages get data from.
//   Demo data: lib/mock.ts.
//   Live data: lib/server/live.ts for the signed-in organisation.
// Which one: the sidebar's Demo/Live switch, else DATA_BACKEND (lib/server/mode.ts).
// Both return the same shapes, so pages and views don't care which is active.

import * as mock from './mock';
import { isLiveMode } from './server/mode';
import * as live from './server/live';
import { requireSession } from './server/session';

export async function getEarnings() {
  if (await isLiveMode()) return live.earnings(await requireSession('publisher'));
  return {
    today: mock.earningsToday,
    month: mock.monthStats,
    daily: mock.dailyShare,
    recentUses: mock.recentUses,
    topArticles: mock.topArticles,
    payout: mock.payout,
    pricePer1k: mock.PRICE_PER_1K,
    share: mock.REVENUE_SHARE,
    licenceVersion: mock.licenceVersions[0]!.version,
  };
}

export async function getSources() {
  if (await isLiveMode()) return live.sources(await requireSession('publisher'));
  return { sources: mock.sources, steps: mock.processingSteps, latestItem: mock.latestItem, uploadSourceId: 'src_3' as string | null };
}

export async function getLicence() {
  if (await isLiveMode()) return live.licence(await requireSession('publisher'));
  return { versions: mock.licenceVersions, share: mock.REVENUE_SHARE, monthTokens: mock.monthStats.tokens, publisherName: mock.publisher.name };
}

export async function getContent() {
  if (await isLiveMode()) return live.content(await requireSession('publisher'));
  return { rows: mock.contentRows, totals: mock.contentTotals };
}

export async function getKeys() {
  if (await isLiveMode()) return live.keys(await requireSession('buyer'));
  return { keys: mock.apiKeys };
}

export async function getPlayground() {
  if (await isLiveMode()) return live.playground(await requireSession('buyer'));
  return { keys: mock.apiKeys.filter((k) => !k.revoked), corpus: mock.searchCorpus, pricePer1k: mock.PRICE_PER_1K };
}

export async function getUsage() {
  if (await isLiveMode()) return live.usage(await requireSession('buyer'));
  return { usage: mock.usage, quota: mock.buyer.monthlyQuotaTokens };
}

export const isLive = isLiveMode;
