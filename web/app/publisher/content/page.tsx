import type { Metadata } from 'next';
import { getContent, isLive } from '@/lib/data';
import { ContentView } from './ContentView';

export const metadata: Metadata = { title: 'Content' };

export default async function ContentPage() {
  const data = await getContent();
  return <ContentView {...data} live={await isLive()} />;
}
