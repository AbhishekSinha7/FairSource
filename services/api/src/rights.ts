// Rights checks. Two layers:
//  1. isServable: the chunk's own stamped fields (also used as the vector pre-filter).
//  2. isLiveServable: the chunk's document and the publisher's licence as they are
//     NOW, so an opt-out, a withdrawal or a licence change applies on the next
//     request even before chunks are re-stamped.
// The same functions are used by search, answer, documents and MCP.

import type { Buyer, Chunk, Licence, Use } from '@fairsource/shared';
import type { DocView } from './ports.js';

export function isServable(
  chunk: Pick<Chunk, 'servable' | 'optOut' | 'uses' | 'territories'>,
  buyer: Pick<Buyer, 'country' | 'status'>,
  use: Use,
): boolean {
  if (!chunk.servable || chunk.optOut) return false; // safety, dedup, withdrawn, publisher opt-out
  if (!chunk.uses.includes(use)) return false; // licence allows this kind of use
  const t = chunk.territories;
  if (!(t.includes('GLOBAL') || (t as string[]).includes(buyer.country))) return false; // territory
  if (buyer.status !== 'active') return false; // buyer in good standing
  return true;
}

/** The document-level `servable` rule from the shared schema, computed from current fields. */
export function documentServable(d: Pick<DocView, 'status' | 'optOut' | 'duplicateOf' | 'needsReview' | 'safety' | 'version'>): boolean {
  return d.status === 'done' && d.version > 0 && !d.optOut && !d.duplicateOf && !d.needsReview && d.safety === 'ok';
}

export function licenceAllows(l: Pick<Licence, 'active' | 'uses' | 'territories'> | undefined, buyer: Pick<Buyer, 'country'>, use: Use): boolean {
  if (!l || !l.active || !l.uses.includes(use)) return false;
  return l.territories.includes('GLOBAL') || (l.territories as string[]).includes(buyer.country);
}

export function isLiveServable(
  chunk: Pick<Chunk, 'servable' | 'optOut' | 'documentVersion'>,
  doc: DocView | undefined,
  licence: Licence | undefined,
  buyer: Pick<Buyer, 'country' | 'status'>,
  use: Use,
): boolean {
  if (!chunk.servable || chunk.optOut || buyer.status !== 'active') return false;
  if (!doc || !documentServable(doc)) return false;
  if (doc.version !== chunk.documentVersion) return false; // a chunk left over from an older version
  return licenceAllows(licence, buyer, use);
}
