// Demo data matching the dashboard mockups, for local runs (API_BACKEND=memory) and tests.

import { randomBytes } from 'node:crypto';
import type { Licence } from '@fairsource/shared';
import { hashKey } from './auth.js';
import type { DocView } from './ports.js';
import type { HashEmbedder, MemoryBlobs, MemoryStore } from './memory.js';

const T = new Date('2026-11-17T06:00:00Z');

interface DemoDoc {
  id: string;
  publisherId: string;
  title: string;
  language: string;
  url: string;
  paragraphs: string[];
  over?: Partial<DocView>;
}

export const DEMO_DOCS: DemoDoc[] = [
  {
    id: '9f2c00000000000000000000000000e1',
    publisherId: 'pub_123',
    title: 'पुणे शहरात नवीन मेट्रो मार्ग',
    language: 'mr',
    url: 'https://example.in/pune/metro-line-3',
    paragraphs: [
      'हिंजवडी ते शिवाजीनगर या नव्या मेट्रो मार्गाचे काम अंतिम टप्प्यात असल्याचे अधिकाऱ्यांनी सांगितले. पुणे मेट्रो का नया रूट हिंजवडी शिवाजीनगर.',
      'नव्या मार्गामुळे आयटी पार्कमधील कर्मचाऱ्यांचा प्रवासाचा वेळ कमी होईल, अशी अपेक्षा आहे. मेट्रो रूट पुणे.',
    ],
  },
  {
    id: '41ab00000000000000000000000000b7',
    publisherId: 'pub_456',
    title: 'हिंजवडी में यातायात व्यवस्था में बदलाव',
    language: 'hi',
    url: 'https://sahyadri.example/hinjewadi-traffic',
    paragraphs: ['मेट्रो निर्माण कार्य के चलते हिंजवडी क्षेत्र में कुछ मार्गों पर यातायात बदला गया है। पुणे मेट्रो का काम जारी है।'],
  },
  {
    id: 'c5e200000000000000000000000000a0',
    publisherId: 'pub_123',
    title: 'Pune Metro Line 3: what changes for commuters',
    language: 'en',
    url: 'https://example.in/en/metro-line-3-commuters',
    paragraphs: ['The Hinjewadi to Shivajinagar Pune metro line will add 23 stations, with the first section expected to open next year.'],
  },
  {
    id: '1e6a00000000000000000000000070aa',
    publisherId: 'pub_123',
    title: 'संपादकीय: मेट्रो आणि पाण्याचे नियोजन',
    language: 'mr',
    url: 'https://example.in/editorial/metro-water',
    paragraphs: ['पुणे मेट्रो मार्गाचे काम सुरू असताना पाण्याचे नियोजनही आवश्यक आहे. मेट्रो पुणे रूट.'],
    over: { optOut: true }, // the publisher opted this article out
  },
  {
    id: 'a1c700000000000000000000000000e3',
    publisherId: 'pub_123',
    title: 'कोथरूड मेट्रो स्थानकाचे काम',
    language: 'mr',
    url: 'https://example.in/kothrud-metro',
    paragraphs: ['कोथरूड मेट्रो स्थानकाचे काम सुरू झाले आहे. पुणे मेट्रो का नया रूट.'],
    over: { status: 'withdrawn' }, // removed from the publisher's site
  },
  {
    id: 'deccan0000000000000000000000beef',
    publisherId: 'pub_789',
    title: "Pune's old wadas: a survey",
    language: 'en',
    url: 'https://deccanarchive.example/wadas',
    paragraphs: ['A survey of the old wadas of Pune, the courtyard houses of the Peshwa era, recorded in 1952.'],
  },
];

export const DEMO_LICENCES: Licence[] = [
  { id: 'lic_123_v3', publisherId: 'pub_123', uses: ['rag'], territories: ['IN', 'GLOBAL'], pricePer1kTokensMicros: 2000, active: true, version: 3, createdAt: T },
  { id: 'lic_456_v1', publisherId: 'pub_456', uses: ['rag'], territories: ['IN'], pricePer1kTokensMicros: 2000, active: true, version: 1, createdAt: T },
  { id: 'lic_789_v2', publisherId: 'pub_789', uses: ['rag', 'training'], territories: ['GLOBAL'], pricePer1kTokensMicros: 2000, active: true, version: 2, createdAt: T },
];

/** Seeds publishers, licences, documents, chunks, a buyer and a key. Returns the full demo key. */
export function seedDemo(store: MemoryStore, blobs: MemoryBlobs, embedder: HashEmbedder, key = `fs_k7f2a9qd_${randomBytes(16).toString('hex')}`): string {
  store.publishers.set('pub_123', { id: 'pub_123', name: 'Example Marathi Daily', revenueSharePct: 75 });
  store.publishers.set('pub_456', { id: 'pub_456', name: 'Sahyadri Samachar', revenueSharePct: 75 });
  store.publishers.set('pub_789', { id: 'pub_789', name: 'Deccan Archive Trust', revenueSharePct: 75 });
  store.licences.push(...DEMO_LICENCES.map((l) => ({ ...l })));

  for (const d of DEMO_DOCS) {
    const cleanUri = `gs://fs-dev-clean/${d.publisherId}/${d.id}/v1.json`;
    const doc: DocView = {
      id: d.id,
      publisherId: d.publisherId,
      title: d.title,
      sourceUrl: d.url,
      canonicalUrl: d.url,
      publishedAt: T,
      language: d.language,
      version: 1,
      status: 'done',
      optOut: false,
      duplicateOf: null,
      needsReview: false,
      safety: 'ok',
      tokenCount: 0,
      cleanUri,
      summary: d.paragraphs[0]!.slice(0, 120),
      author: null,
      contentType: 'news',
      ...d.over,
    };
    const lic = DEMO_LICENCES.find((l) => l.publisherId === d.publisherId)!;
    d.paragraphs.forEach((p, n) => {
      const text = `${d.title}\n${p}`;
      const tokens = 600 + n * 20;
      doc.tokenCount += tokens;
      store.chunks.set(`${d.id}_v1_${n}`, {
        id: `${d.id}_v1_${n}`,
        documentId: d.id,
        documentVersion: 1,
        n,
        publisherId: d.publisherId,
        text,
        tokenCount: tokens,
        embedding: embedder.vector(text),
        language: d.language,
        // Chunks still look servable: as if the re-stamp hasn't run yet after the opt-out/withdrawal.
        servable: true,
        optOut: false,
        uses: lic.uses,
        territories: lic.territories,
        licenceId: lic.id,
        licenceVersion: lic.version,
      });
    });
    store.documents.set(d.id, doc);
    blobs.objects.set(cleanUri, { title: d.title, body: d.paragraphs.join('\n\n') });
  }

  store.buyers.set('buy_77', { id: 'buy_77', name: 'Kavya AI', country: 'IN', status: 'active', monthlyQuotaTokens: 10_000_000, usedTokensThisMonth: 0 });
  store.keys.set(key.slice(3, 11), {
    prefix: key.slice(3, 11),
    buyerId: 'buy_77',
    name: 'Production agent',
    hash: hashKey(key),
    scopes: ['search', 'answer', 'documents'],
    revokedAt: null,
    lastUsedAt: null,
  });
  return key;
}
