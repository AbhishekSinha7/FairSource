import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { DataModeSwitch } from '@/components/DataModeSwitch';
import { LIVE_CONFIGURED, MODE_LOCKED } from '@/lib/server/env';
import { isLiveMode } from '@/lib/server/mode';
import { currentSession } from '@/lib/server/session';
import { LoginButton } from './LoginButton';

export const metadata: Metadata = { title: 'Sign in' };

function Logo() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-9 place-items-center rounded-lg bg-brand" aria-hidden="true">
        <svg viewBox="0 0 20 20" className="size-5 text-white">
          <path d="M5 6h10M5 10h10M5 14h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="font-display text-2xl font-semibold tracking-tight">FairSource</span>
    </div>
  );
}

export default async function LoginPage() {
  if (!(await isLiveMode())) redirect('/publisher/earnings'); // demo data needs no sign-in
  const s = await currentSession();
  if (s) redirect(s.role === 'publisher' ? '/publisher/earnings' : '/buyer/playground');

  return (
    <main className="grid min-h-[80vh] place-items-center">
      <div className="w-full max-w-md rounded-2xl border border-line bg-card p-8">
        <Logo />
        {LIVE_CONFIGURED ? (
          <>
            <h1 className="mt-8 font-display text-2xl font-semibold">Sign in</h1>
            <p className="mt-2 text-[15px] text-muted">Publishers and AI buyers sign in with the Google account the FairSource team linked to their organisation.</p>
            <LoginButton
              config={{
                apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? '',
                authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
                projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '',
              }}
            />
          </>
        ) : (
          <>
            <h1 className="mt-8 font-display text-2xl font-semibold">Live data isn&apos;t connected yet</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-muted">
              Live data reads your real articles, earnings and keys from the <span className="font-mono text-ink">fs-dev</span> Firebase project, which
              hasn&apos;t been set up yet. Until then, switch back to the demo data.
            </p>
            <ol className="mt-5 list-decimal space-y-1.5 pl-5 text-[15px]">
              <li>
                Create the project and run <span className="font-mono">infra/setup.sh</span>
              </li>
              <li>Turn on Google sign-in in Firebase Authentication</li>
              <li>
                Set <span className="font-mono">NEXT_PUBLIC_FIREBASE_*</span> in <span className="font-mono">.env</span> (see <span className="font-mono">.env.example</span>)
              </li>
              <li>
                Link your account with <span className="font-mono">infra/create-org.ts</span>
              </li>
            </ol>
          </>
        )}
        {!MODE_LOCKED && (
          <div className="mt-8 border-t border-line pt-5">
            <DataModeSwitch live tone="light" />
          </div>
        )}
      </div>
    </main>
  );
}
