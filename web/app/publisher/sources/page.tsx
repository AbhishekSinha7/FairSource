import type { Metadata } from 'next';
import { getSources, isLive } from '@/lib/data';
import { SourcesView } from './SourcesView';

export const metadata: Metadata = { title: 'Sources' };

export default async function SourcesPage() {
  const data = await getSources();
  return <SourcesView {...data} live={await isLive()} />;
}
