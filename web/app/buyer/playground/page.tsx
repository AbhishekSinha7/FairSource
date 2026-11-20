import type { Metadata } from 'next';
import { getPlayground, isLive } from '@/lib/data';
import { PlaygroundView } from './PlaygroundView';

export const metadata: Metadata = { title: 'Playground' };

export default async function PlaygroundPage() {
  const data = await getPlayground();
  return <PlaygroundView {...data} live={await isLive()} />;
}
