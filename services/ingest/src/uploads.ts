// Uploads: the dashboard asks for a signed URL, the browser uploads straight to
// gs://<raw>/uploads/..., and Eventarc calls onUploadFinalized for each new
// object. ZIPs are expanded; each file becomes its own document.

import { randomUUID } from 'node:crypto';
import { contentHashFor, identityKeyFor } from '@fairsource/shared';
import { unzipSync } from 'fflate';
import type { Deps } from './deps.js';
import { commit, type ItemOutcome } from './items.js';

const BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  zip: 'application/zip',
};
const ALLOWED_TYPES = new Set([...Object.values(BY_EXT), 'application/x-zip-compressed']);

export const contentTypeForName = (name: string): string | null => BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? null;

export class UploadError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'too_large' | 'unsupported_type',
    message: string,
  ) {
    super(message);
  }
}

export interface SignRequest {
  publisherId: string;
  sourceId: string;
  filename: string;
  contentType: string;
  size: number;
}

export async function signUpload(deps: Deps, req: SignRequest) {
  const source = await deps.store.getSource(req.sourceId);
  if (!source || source.type !== 'upload') throw new UploadError('not_found', 'upload source not found');
  if (source.publisherId !== req.publisherId) throw new UploadError('forbidden', 'source belongs to another publisher');
  if (req.size > deps.cfg.maxBytes) throw new UploadError('too_large', `files can be up to ${Math.round(deps.cfg.maxBytes / 1024 / 1024)} MB`);
  if (!ALLOWED_TYPES.has(req.contentType)) throw new UploadError('unsupported_type', 'upload PDFs, images (JPEG, PNG, WebP, TIFF) or a ZIP');

  const safe = req.filename.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '_').slice(-120) || 'file';
  const path = `uploads/${req.publisherId}/${req.sourceId}/${randomUUID()}/${safe}`;
  const expires = new Date(deps.now().getTime() + 15 * 60 * 1000);
  return { uploadUrl: await deps.blobs.signUpload(path, req.contentType, expires), path, expiresAt: expires.toISOString() };
}

interface FileIn {
  name: string;
  bytes: Uint8Array;
  contentType: string;
}

const isZip = (name: string, b: Uint8Array) => name.toLowerCase().endsWith('.zip') || (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04);

function expand(deps: Deps, name: string, bytes: Uint8Array): { files: FileIn[]; rejected: string[] } {
  if (!isZip(name, bytes)) {
    const contentType = contentTypeForName(name);
    return contentType && contentType !== 'application/zip' ? { files: [{ name, bytes, contentType }], rejected: [] } : { files: [], rejected: [name] };
  }
  const rejected: string[] = [];
  let count = 0;
  let total = 0;
  const entries = unzipSync(bytes, {
    filter: (f) => {
      const base = f.name.split('/').pop() ?? '';
      if (f.name.endsWith('/') || f.name.startsWith('__MACOSX/') || base.startsWith('.')) return false;
      const type = contentTypeForName(base);
      const ok = type !== null && type !== 'application/zip' && f.originalSize <= deps.cfg.maxBytes && count < deps.cfg.maxZipEntries && total + f.originalSize <= 20 * deps.cfg.maxBytes;
      if (!ok) rejected.push(f.name);
      else {
        count += 1;
        total += f.originalSize;
      }
      return ok;
    },
  });
  const files = Object.entries(entries).map(([path, b]) => {
    const base = path.split('/').pop()!;
    return { name: base, bytes: b, contentType: contentTypeForName(base)! };
  });
  return { files, rejected };
}

export async function onUploadFinalized(deps: Deps, objectPath: string) {
  const m = objectPath.match(/^uploads\/([^/]+)\/([^/]+)\/[^/]+\/(.+)$/);
  if (!m) return { ignored: true as const };
  const [, publisherId, sourceId, name] = m as unknown as [string, string, string, string];

  const source = await deps.store.getSource(sourceId);
  if (!source || source.type !== 'upload' || source.publisherId !== publisherId) {
    deps.log({ severity: 'WARNING', event: 'upload_orphan', path: objectPath });
    return { ignored: true as const };
  }

  const bytes = await deps.blobs.read(objectPath);
  const { files, rejected } = expand(deps, name, bytes);
  const outcomes: Array<{ name: string; outcome: ItemOutcome }> = [];
  for (const f of files) {
    const contentHash = contentHashFor(Buffer.from(f.bytes));
    const outcome = await commit(
      deps,
      source,
      {
        key: identityKeyFor({ kind: 'upload', contentHash }),
        contentHash,
        bytes: f.bytes,
        contentType: f.contentType,
        sourceUrl: null,
        canonicalUrl: null,
        guid: null,
        title: f.name.replace(/\.[^.]+$/, ''),
      },
      'scheduled',
    );
    outcomes.push({ name: f.name, outcome });
  }
  await deps.blobs.delete(objectPath);
  await deps.store.updateSource(sourceId, { lastFetchedAt: deps.now() });
  deps.log({ event: 'upload_processed', sourceId, path: objectPath, files: outcomes.length, rejected });
  return { ignored: false as const, outcomes, rejected };
}
