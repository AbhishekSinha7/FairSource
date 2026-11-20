// Demo data for the dashboards, consistent with the mockups and with itself
// (shares, totals and prices add up). Pages read it only through lib/data.ts,
// so wiring Firestore and BigQuery later means changing data.ts, not the pages.

import type { LicenceVersionView } from './licence';
import type { StatusInput } from './status';

export const PRICE_PER_1K = 0.002;
export const REVENUE_SHARE = 0.75;

// ---------------------------------------------------------------- publisher

export const publisher = {
  id: 'pub_123',
  name: 'Example Marathi Daily',
  subtitle: 'Pune · Marathi, Hindi, English',
};

export const licenceVersions: LicenceVersionView[] = [
  { version: 3, uses: ['rag'], territories: ['IN', 'GLOBAL'], pricePer1k: 0.002, createdAt: '2026-11-12' },
  { version: 2, uses: ['rag'], territories: ['IN'], pricePer1k: 0.002, createdAt: '2026-11-05' },
  { version: 1, uses: ['rag'], territories: ['IN'], pricePer1k: 0.0015, createdAt: '2026-11-01' },
];

export const earningsToday = { shareUSD: 1.8594, tokens: 1_239_570, uses: 517 };

// Publisher's 75% share per day, 20 Oct to today (18 Nov). November sums to 27.62.
const DAILY = [
  0.12, 0.18, 0.15, 0.22, 0.31, 0.27, 0.35, 0.42, 0.38, 0.55, 0.63, 0.6,
  0.88, 0.97, 1.12, 1.04, 1.29, 1.43, 1.17, 1.48, 1.61, 1.55, 1.52, 1.65, 1.55, 1.84, 1.99, 2.1, 2.57, 1.86,
];
export const dailyShare = DAILY.map((value, i) => {
  const d = new Date(Date.UTC(2026, 9, 20 + i));
  return { date: d.toISOString().slice(0, 10), value };
});

export const monthStats = {
  gross: 36.82,
  share: 27.62,
  tokens: 18_410_000,
  articlesUsed: 412,
  articlesTotal: 2046,
};

export interface UseEvent {
  id: string;
  time: string;
  title: string;
  buyer: string;
  endpoint: 'search' | 'answer' | 'MCP';
  tokens: number;
}

export const recentUses: UseEvent[] = [
  { id: 'u5', time: '23:57:34', title: 'पुणे विद्यापीठ परीक्षांचे सुधारित वेळापत्रक', buyer: 'Setu Research', endpoint: 'search', tokens: 960 },
  { id: 'u4', time: '23:57:30', title: 'हिंजवडी में यातायात व्यवस्था में बदलाव', buyer: 'Lipi Agents', endpoint: 'answer', tokens: 2210 },
  { id: 'u3', time: '23:41:02', title: 'पुणे शहरात नवीन मेट्रो मार्ग', buyer: 'Kavya AI', endpoint: 'MCP', tokens: 1840 },
  { id: 'u2', time: '23:40:37', title: 'पुणे विद्यापीठ परीक्षांचे सुधारित वेळापत्रक', buyer: 'Setu Research', endpoint: 'search', tokens: 960 },
  { id: 'u1', time: '23:39:58', title: 'हिंजवडी में यातायात व्यवस्था में बदलाव', buyer: 'Lipi Agents', endpoint: 'answer', tokens: 2210 },
];

export const topArticles = [
  { title: 'पुणे शहरात नवीन मेट्रो मार्ग', language: 'Marathi', uses: 1204, tokens: 2_210_000 },
  { title: 'पिंपरी-चिंचवडमध्ये पाणीपुरवठ्याचे नवे वेळापत्रक', language: 'Marathi', uses: 846, tokens: 1_520_000 },
  { title: 'पुणे विद्यापीठ परीक्षांचे सुधारित वेळापत्रक', language: 'Marathi', uses: 611, tokens: 1_090_000 },
  { title: 'हिंजवडी में यातायात व्यवस्था में बदलाव', language: 'Hindi', uses: 498, tokens: 880_000 },
  { title: "Pune's old wadas: a survey", language: 'English', uses: 302, tokens: 610_000, scan: true },
];

export const payout = {
  date: '3 Dec',
  carried: 4.06,
  account: 'Stripe Connect · test mode',
  minimum: 10,
};

// ------------------------------------------------------------------ sources

export interface SourceView {
  id: string;
  name: string;
  detail: string;
  type: 'RSS' | 'Sitemap' | 'Upload' | 'CMS';
  schedule: string;
  lastRun: string;
  items: number | null;
  itemsLabel?: string;
  status: 'healthy' | 'review' | 'backfilling' | 'syncing' | 'error' | 'soon';
  reviewCount?: number;
  backfill?: { done: number; total: number };
  lastSyncNote?: string;
}

export const sources: SourceView[] = [
  { id: 'src_1', name: 'Pune city news', detail: 'example.in/rss/pune', type: 'RSS', schedule: 'Every 30 min', lastRun: '4 min ago', items: 1612, status: 'healthy' },
  { id: 'src_2', name: 'News sitemap', detail: 'example.in/news-sitemap.xml', type: 'Sitemap', schedule: 'Every 30 min', lastRun: '4 min ago', items: 384, status: 'healthy' },
  { id: 'src_3', name: 'Print archive scans', detail: 'Uploaded from the dashboard', type: 'Upload', schedule: 'On upload', lastRun: 'Today, 23:38', items: 50, itemsLabel: '50 pages', status: 'review', reviewCount: 2 },
  { id: 'src_cms', name: 'WordPress or Ghost', detail: 'Connect your CMS directly', type: 'CMS', schedule: '—', lastRun: '—', items: null, status: 'soon' },
];

export const processingSteps: Array<{ title: string; detail: string; ok: boolean }> = [
  { title: 'Fetched and stored', detail: 'Raw file saved · content hash 9f2c…e1', ok: true },
  { title: 'Text extracted', detail: 'Gemini Pro OCR · 3 pages in reading order', ok: true },
  { title: 'Cleaned and structured', detail: 'Gemini Flash · title, date, author, 4 topics', ok: true },
  { title: 'Language detected', detail: 'Marathi (mr) · Devanagari · language check agrees', ok: true },
  { title: 'Duplicate check passed', detail: 'Gemma · no matching story at another URL', ok: true },
  { title: 'Safety check passed', detail: 'Gemma · label: ok', ok: true },
  { title: '7 chunks embedded', detail: 'Gemini embeddings · 768 dimensions', ok: true },
  { title: 'Licensed and searchable', detail: 'Licence v3 · RAG · India and global', ok: true },
];

export const latestItem = { name: 'archive-scan-0412.pdf', detail: '3 pages · uploaded 23:38' };

// ------------------------------------------------------------------ content

export interface ContentRow extends StatusInput {
  id: string;
  title: string;
  via: 'RSS' | 'Sitemap' | 'Scan' | 'Upload';
  detail: string;
  language: 'Marathi' | 'Hindi' | 'English';
  type: 'News' | 'Opinion' | 'Feature' | 'Book' | 'Other';
  published: string;
  uses: number;
  version: number;
}

const row = (r: Partial<ContentRow> & Pick<ContentRow, 'id' | 'title' | 'via' | 'detail' | 'language' | 'type' | 'published' | 'uses'>): ContentRow => ({
  status: 'done', optOut: false, duplicateOf: null, needsReview: false, safety: 'ok', version: 1, ...r,
});

export const contentRows: ContentRow[] = [
  row({ id: '9f2c01', title: 'पुणे शहरात नवीन मेट्रो मार्ग', via: 'RSS', detail: '7 chunks', language: 'Marathi', type: 'News', published: '17 Nov', uses: 1204 }),
  row({ id: '3ab811', title: 'पिंपरी-चिंचवडमध्ये पाणीपुरवठ्याचे नवे वेळापत्रक', via: 'RSS', detail: '5 chunks', language: 'Marathi', type: 'News', published: '16 Nov', uses: 846, version: 2 }),
  row({ id: '77d0a4', title: 'शनिवारवाडा परिसरात पार्किंगचे नवे नियम', via: 'Sitemap', detail: 'same story at another URL', language: 'Marathi', type: 'News', published: '18 Nov', uses: 0, duplicateOf: 'c41e9b' }),
  row({ id: '51be2f', title: 'पुणे विद्यापीठ परीक्षांचे सुधारित वेळापत्रक', via: 'RSS', detail: '4 chunks', language: 'Marathi', type: 'News', published: '15 Nov', uses: 611 }),
  row({ id: '41ab07', title: 'हिंजवडी में यातायात व्यवस्था में बदलाव', via: 'RSS', detail: '6 chunks', language: 'Hindi', type: 'News', published: '15 Nov', uses: 498 }),
  row({ id: 'e09a6c', title: "Pune's old wadas: a survey", via: 'Scan', detail: '12 pages · Gemini OCR', language: 'English', type: 'Book', published: '1952', uses: 302 }),
  row({ id: '6c13d2', title: 'Readers’ letters, 14 November', via: 'Sitemap', detail: 'language checks disagree', language: 'English', type: 'Opinion', published: '14 Nov', uses: 0, needsReview: true }),
  row({ id: 'b8f450', title: 'गणेशोत्सव मंडळ कार्यकर्त्यांची यादी', via: 'Upload', detail: 'many personal details', language: 'Marathi', type: 'Other', published: '10 Nov', uses: 0, safety: 'pii_heavy' }),
  row({ id: 'a1c7e3', title: 'कोथरूडमध्ये नवे उद्यान खुले', via: 'RSS', detail: 'removed from example.in on 17 Nov', language: 'Marathi', type: 'News', published: '9 Nov', uses: 233, status: 'withdrawn' }),
  row({ id: '2d94b1', title: 'पुणे में बारिश का येलो अलर्ट', via: 'RSS', detail: '3 chunks', language: 'Hindi', type: 'News', published: '14 Nov', uses: 187 }),
  row({ id: 'c5e2a0', title: 'Pune announces grants for early-stage startups', via: 'RSS', detail: '4 chunks', language: 'English', type: 'News', published: '13 Nov', uses: 142 }),
  row({ id: '8e71f9', title: 'सिंहगड किल्ल्यावर पर्यटकांसाठी नव्या सुविधा', via: 'RSS', detail: '6 chunks', language: 'Marathi', type: 'Feature', published: '12 Nov', uses: 129, version: 3 }),
  row({ id: '0f3b6d', title: 'Monsoon roads: a ward-by-ward audit', via: 'Sitemap', detail: '9 chunks', language: 'English', type: 'Feature', published: '11 Nov', uses: 96 }),
  row({ id: '94ac12', title: 'पुणे पुस्तक महोत्सवाच्या तारखा जाहीर', via: 'RSS', detail: '2 chunks', language: 'Marathi', type: 'News', published: '11 Nov', uses: 88 }),
  row({ id: '7b2e55', title: 'Deccan College lectures, 1938', via: 'Scan', detail: '8 pages · Gemini OCR', language: 'English', type: 'Book', published: '1938', uses: 64 }),
  row({ id: 'd3f8c9', title: 'हडपसर रेलवे स्टेशन का विस्तार', via: 'Sitemap', detail: '4 chunks', language: 'Hindi', type: 'News', published: '10 Nov', uses: 51 }),
  row({ id: '1e6a70', title: 'संपादकीय: पाण्याचे नियोजन आताच हवे', via: 'RSS', detail: '3 chunks', language: 'Marathi', type: 'Opinion', published: '9 Nov', uses: 44, optOut: true }),
];

export const contentTotals = { documents: 2046, servable: 1988, needsReview: 14 };

// -------------------------------------------------------------------- buyer

export const buyer = {
  id: 'buy_77',
  name: 'Kavya AI',
  subtitle: 'India · 10M tokens a month',
  country: 'IN',
  monthlyQuotaTokens: 10_000_000,
};

export interface KeyView {
  prefix: string;
  name: string;
  scopes: Array<'search' | 'answer' | 'documents'>;
  created: string;
  lastUsed: string;
  revoked: boolean;
}

export const apiKeys: KeyView[] = [
  { prefix: 'k7f2a9qd', name: 'Production agent', scopes: ['search', 'answer', 'documents'], created: '12 Nov', lastUsed: '2 min ago', revoked: false },
  { prefix: 'p3m8x1tz', name: 'Staging', scopes: ['search'], created: '14 Nov', lastUsed: 'Yesterday', revoked: false },
  { prefix: 'a1d0e5vq', name: 'Buildathon demo (old)', scopes: ['search'], created: '8 Nov', lastUsed: '10 Nov', revoked: true },
];

export interface ChunkResult {
  chunkId: string;
  score: number;
  language: 'mr' | 'hi' | 'en';
  title: string;
  text: string;
  publisher: string;
  licence: string;
  tokens: number;
  url: string;
}

/** What /v1/search returns for the demo query, before the language filter and limit. */
export const searchCorpus: ChunkResult[] = [
  { chunkId: '9f2c…e1_v1_3', score: 0.83, language: 'mr', title: 'पुणे शहरात नवीन मेट्रो मार्ग', text: 'हिंजवडी ते शिवाजीनगर या नव्या मेट्रो मार्गाचे काम अंतिम टप्प्यात असल्याचे अधिकाऱ्यांनी सांगितले.', publisher: 'Example Marathi Daily', licence: 'rag/IN+GLOBAL/v3', tokens: 640, url: 'https://example.in/pune/metro-line-3' },
  { chunkId: '9f2c…e1_v1_4', score: 0.79, language: 'mr', title: 'पुणे शहरात नवीन मेट्रो मार्ग', text: 'नव्या मार्गामुळे आयटी पार्कमधील कर्मचाऱ्यांचा प्रवासाचा वेळ कमी होईल, अशी अपेक्षा आहे.', publisher: 'Example Marathi Daily', licence: 'rag/IN+GLOBAL/v3', tokens: 610, url: 'https://example.in/pune/metro-line-3' },
  { chunkId: '41ab…07_v1_1', score: 0.71, language: 'hi', title: 'हिंजवडी में यातायात व्यवस्था में बदलाव', text: 'मेट्रो निर्माण कार्य के चलते हिंजवडी क्षेत्र में कुछ मार्गों पर यातायात बदला गया है।', publisher: 'Sahyadri Samachar', licence: 'rag/IN/v1', tokens: 590, url: 'https://sahyadri.example/hinjewadi-traffic' },
  { chunkId: 'c5e2…a0_v1_2', score: 0.62, language: 'en', title: 'Pune Metro Line 3: what changes for commuters', text: 'The Hinjewadi–Shivajinagar line will add 23 stations, with the first section expected to open next year.', publisher: 'Example Marathi Daily', licence: 'rag/IN+GLOBAL/v3', tokens: 520, url: 'https://example.in/en/metro-line-3-commuters' },
  { chunkId: '2d94…b1_v2_0', score: 0.55, language: 'hi', title: 'पुणे मेट्रो: नए स्टेशनों की सूची', text: 'नए मार्ग पर बालेवाडी, बाणेर और विद्यापीठ चौक प्रमुख स्टेशन होंगे।', publisher: 'Sahyadri Samachar', licence: 'rag/IN/v1', tokens: 480, url: 'https://sahyadri.example/metro-stations' },
];

export const usage = {
  periodLabel: 'November so far',
  nextInvoice: '1 Dec',
  requests: 2511,
  rateLimited: 0,
  // Tokens per day, 1 Nov to today (18 Nov). Sums to 4.62M.
  daily: [85, 115, 160, 180, 190, 210, 225, 240, 250, 265, 275, 285, 300, 315, 330, 345, 360, 490].map((k, i) => ({
    date: `2026-11-${String(i + 1).padStart(2, '0')}`,
    tokens: k * 1000,
  })),
  byEndpoint: [
    { label: '/v1/search', tokens: 2_400_000 },
    { label: '/v1/answer', tokens: 1_430_000 },
    { label: 'mcp', tokens: 790_000 },
  ],
  byLanguage: [
    { label: 'Marathi', tokens: 2_680_000 },
    { label: 'Hindi', tokens: 1_250_000 },
    { label: 'English', tokens: 690_000 },
  ],
  publishers: [
    { name: 'Example Marathi Daily', licence: 'rag/IN+GLOBAL/v3', pricePer1k: 0.002, tokens: 2_710_000 },
    { name: 'Sahyadri Samachar', licence: 'rag/IN/v1', pricePer1k: 0.002, tokens: 1_200_000 },
    { name: 'Deccan Archive Trust', licence: 'rag+training/GLOBAL/v2', pricePer1k: 0.002, tokens: 710_000 },
  ],
};
