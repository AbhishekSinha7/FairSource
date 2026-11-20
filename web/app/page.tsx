import { redirect } from 'next/navigation';
import { isLiveMode } from '@/lib/server/mode';
import { currentSession } from '@/lib/server/session';

export default async function Home() {
  if (!(await isLiveMode())) redirect('/publisher/earnings');
  const s = await currentSession();
  redirect(!s ? '/login' : s.role === 'publisher' ? '/publisher/earnings' : '/buyer/playground');
}
