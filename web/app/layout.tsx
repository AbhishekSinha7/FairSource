import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Shell, type ShellIdentity } from '@/components/Shell';
import { isLiveMode, modeSwitchAvailable } from '@/lib/server/mode';
import { currentSession, orgInfo } from '@/lib/server/session';
import './globals.css';

// Fonts load in the browser from Google Fonts, so builds don't need network access.
const FONTS =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Noto+Sans+Devanagari:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap';

export const metadata: Metadata = {
  title: { default: 'FairSource', template: '%s · FairSource' },
  description: 'Licensed content for AI. Publishers get paid for every use.',
};

async function identity(live: boolean): Promise<ShellIdentity | null> {
  if (!live) return null; // demo mode: the Shell shows the demo organisations and the role switch
  const s = await currentSession();
  if (!s) return null;
  return { role: s.role, org: await orgInfo(s) };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const live = await isLiveMode();
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href={FONTS} />
      </head>
      {/* Browser extensions (Grammarly, ColorZilla, …) add attributes to <body> before React loads. */}
      <body className="antialiased" suppressHydrationWarning>
        <Shell identity={await identity(live)} live={live} modeSwitch={await modeSwitchAvailable()}>
          {children}
        </Shell>
      </body>
    </html>
  );
}
