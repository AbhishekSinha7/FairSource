import type { Tone } from '@/components/ui';

/** The subset of a document the Content page needs to decide its status pill. */
export interface StatusInput {
  status: 'queued' | 'processing' | 'done' | 'failed' | 'withdrawn';
  optOut: boolean;
  duplicateOf: string | null;
  needsReview: boolean;
  safety: 'ok' | 'adult' | 'hate' | 'pii_heavy';
}

/** Same precedence as `servable` in packages/shared/src/schema.ts. */
export function documentStatus(d: StatusInput): { label: string; tone: Tone; servable: boolean } {
  if (d.status === 'withdrawn') return { label: 'Withdrawn · removed from your site', tone: 'neutral', servable: false };
  if (d.status === 'failed') return { label: 'Failed · retrying', tone: 'bad', servable: false };
  if (d.status !== 'done') return { label: 'Processing', tone: 'brand', servable: false };
  if (d.optOut) return { label: 'Opted out', tone: 'neutral', servable: false };
  if (d.duplicateOf) return { label: 'Duplicate · not served twice', tone: 'neutral', servable: false };
  if (d.safety === 'pii_heavy') return { label: 'Not served · personal data', tone: 'bad', servable: false };
  if (d.safety !== 'ok') return { label: 'Not served · safety', tone: 'bad', servable: false };
  if (d.needsReview) return { label: 'Needs review', tone: 'warn', servable: false };
  return { label: 'Servable', tone: 'good', servable: true };
}
