'use client';

import { getApps, initializeApp, type FirebaseOptions } from 'firebase/app';
import { GoogleAuthProvider, getAuth, signInWithPopup, signOut } from 'firebase/auth';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui';

type Role = 'publisher' | 'buyer';
type Reply = { role?: Role; error?: string; message?: string };

const SIDES: Array<{ role: Role; title: string; text: string }> = [
  { role: 'publisher', title: 'Publisher', text: 'Connect a blog or feed, set the licence, and see what AI buyers use and pay for.' },
  { role: 'buyer', title: 'AI buyer', text: 'Create an API key, ask questions in the Playground, and call the API or MCP server.' },
];

export function LoginButton({ config }: { config: FirebaseOptions }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const auth = () => getAuth(getApps()[0] ?? initializeApp(config));

  async function post(idToken: string, as?: Role): Promise<{ ok: boolean; body: Reply }> {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken, as }),
    });
    return { ok: res.ok, body: (await res.json().catch(() => ({}))) as Reply };
  }

  /** Swap the Google sign-in for a session cookie; `as` is the side a judge picked. */
  async function finish(as?: Role) {
    const user = auth().currentUser;
    if (!user) throw new Error('Please sign in again.');
    let r = await post(await user.getIdToken(), as);
    if (r.body.error === 'refresh_token') r = await post(await user.getIdToken(true), as); // now carries the new role
    if (r.body.error === 'choose_role') {
      setChoosing(true);
      setBusy(false);
      return;
    }
    await signOut(auth()); // the server session cookie is what the app uses from here
    if (!r.ok) throw new Error(r.body.message ?? 'Sign-in failed.');
    router.replace(r.body.role === 'buyer' ? '/buyer/playground' : '/publisher/earnings');
    router.refresh();
  }

  async function run(step: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg.includes('popup-closed') ? 'The sign-in window was closed.' : msg);
      setChoosing(false);
      setBusy(false);
    }
  }

  return (
    <>
      {choosing ? (
        <div className="mt-6">
          <p className="text-[15px] font-semibold">Explore FairSource as…</p>
          <div className="mt-3 space-y-3">
            {SIDES.map((s) => (
              <button
                key={s.role}
                type="button"
                disabled={busy}
                onClick={() => run(() => finish(s.role))}
                className="block w-full rounded-xl border border-line bg-card p-4 text-left transition-colors hover:border-brand hover:bg-subtle disabled:opacity-60"
              >
                <span className="block font-semibold">{s.title}</span>
                <span className="mt-1 block text-sm text-muted">{s.text}</span>
              </button>
            ))}
          </div>
          <p className="mt-4 text-sm text-muted">{busy ? 'Setting up…' : 'To try the other side later, sign out and sign in again.'}</p>
        </div>
      ) : (
        <Button className="mt-6 w-full" onClick={() => run(async () => { await signInWithPopup(auth(), new GoogleAuthProvider()); await finish(); })} disabled={busy || !config.apiKey}>
          {busy ? 'Signing in…' : 'Sign in with Google'}
        </Button>
      )}
      {!config.apiKey && <p className="mt-3 text-sm text-bad">Set NEXT_PUBLIC_FIREBASE_API_KEY, _AUTH_DOMAIN and _PROJECT_ID.</p>}
      {error && (
        <p role="alert" className="mt-4 text-[15px] text-bad">
          {error}
        </p>
      )}
    </>
  );
}
