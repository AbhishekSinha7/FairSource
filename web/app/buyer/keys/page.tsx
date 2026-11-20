import type { Metadata } from 'next';
import { getKeys, isLive } from '@/lib/data';
import { KeysView } from './KeysView';

export const metadata: Metadata = { title: 'API keys & MCP' };

export default async function KeysPage() {
  const data = await getKeys();
  return <KeysView {...data} live={await isLive()} />;
}
