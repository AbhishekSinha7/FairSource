import type { Metadata } from 'next';
import { getLicence, isLive } from '@/lib/data';
import { LicenceView } from './LicenceView';

export const metadata: Metadata = { title: 'Licence' };

export default async function LicencePage() {
  const data = await getLicence();
  return <LicenceView {...data} live={await isLive()} />;
}
