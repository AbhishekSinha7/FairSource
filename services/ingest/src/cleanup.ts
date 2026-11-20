// Deletes the stored content of withdrawn documents (decision 6): chunks, the
// cleaned JSON of every version, and raw files no other live document uses.
// The document row (title, IDs, hashes) and every ledger row stay, so past
// earnings and statements remain correct. Runs after the daily sweep.

import type { Deps } from './deps.js';

export interface CleanupSummary {
  documents: number;
  chunks: number;
  files: number;
  keptShared: number;
}

export async function cleanupWithdrawn(deps: Deps, limit = 200, deadline?: number): Promise<CleanupSummary> {
  const { store, blobs, log } = deps;
  const out: CleanupSummary = { documents: 0, chunks: 0, files: 0, keptShared: 0 };
  const stop = deadline ?? deps.now().getTime() + deps.cfg.runBudgetMs;

  for (const doc of await store.listWithdrawnForCleanup(limit)) {
    if (deps.now().getTime() >= stop) break;
    // A restored document is queued again by ingest; skip anything that is no longer withdrawn.
    const current = await store.getDocument(doc.id);
    if (!current || current.status !== 'withdrawn') continue;

    out.chunks += await store.deleteChunks(doc.id);

    const versions = await store.listVersionFiles(doc.id);
    const raws = new Set([doc.rawUri, ...versions.map((v) => v.rawUri)].filter((u): u is string => !!u));
    const cleans = new Set([doc.cleanUri, ...versions.map((v) => v.cleanUri)].filter((u): u is string => !!u));
    for (const uri of cleans) {
      await blobs.deleteUri(uri); // clean paths include the docId, so they are never shared
      out.files += 1;
    }
    for (const uri of raws) {
      if (await store.rawFileInUse(doc.publisherId, uri, doc.id)) {
        out.keptShared += 1; // same text under another URL (a duplicate) still needs it
        continue;
      }
      await blobs.deleteUri(uri);
      out.files += 1;
    }
    await store.clearVersionFiles(doc.id);
    await store.updateDocument(doc.id, { rawUri: null, cleanUri: null, cleanedAt: deps.now() });
    out.documents += 1;
    log({ event: 'document_cleaned', docId: doc.id, withdrawnReason: doc.withdrawnReason });
  }
  return out;
}
