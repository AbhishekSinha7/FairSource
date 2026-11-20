import type { Territory, Use } from '@fairsource/shared';

export interface LicenceTerms {
  uses: Use[];
  territories: Territory[];
  pricePer1k: number; // USD per 1,000 tokens
}

export interface LicenceVersionView extends LicenceTerms {
  version: number;
  createdAt: string; // yyyy-mm-dd
}

const USE_ORDER: Use[] = ['rag', 'training'];
const TERRITORY_ORDER: Territory[] = ['IN', 'GLOBAL'];

/** The tag buyers see on every result, e.g. "rag/IN+GLOBAL/v3". */
export function licenceTag(t: Pick<LicenceTerms, 'uses' | 'territories'>, version: number): string {
  const uses = USE_ORDER.filter((u) => t.uses.includes(u)).join('+') || 'none';
  const terr = TERRITORY_ORDER.filter((x) => t.territories.includes(x)).join('+') || 'none';
  return `${uses}/${terr}/v${version}`;
}

export function sameTerms(a: LicenceTerms, b: LicenceTerms): boolean {
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((v) => y.includes(v));
  return eq(a.uses, b.uses) && eq(a.territories, b.territories) && a.pricePer1k === b.pricePer1k;
}
