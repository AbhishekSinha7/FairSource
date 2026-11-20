import type { Metadata } from 'next';
import { getEarnings, isLive } from '@/lib/data';
import { EarningsView } from './EarningsView';

export const metadata: Metadata = { title: 'Earnings' };

export default async function EarningsPage() {
  const data = await getEarnings();
  return <EarningsView {...data} live={await isLive()} />;
}
