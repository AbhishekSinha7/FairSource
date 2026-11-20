'use client';

import { getApps, initializeApp, type FirebaseOptions } from 'firebase/app';
import { GoogleAuthProvider, getAuth, signInWithPopup, signOut } from 'firebase/auth';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui';

export function LoginButton({ config }: { config: FirebaseOptions }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const app = getApps()[0] ?? initializeApp(config);
      const auth = getAuth(app);
      const cred = await signInWithPopup(auth, new GoogleAuthProvider());
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: await cred.user.getIdToken() }),
      });
      const body = (await res.json()) as { role?: string; message?: string };
      await signOut(auth); // the server session cookie is what the app uses from here
      if (!res.ok) throw new Error(body.message ?? 'Sign-in failed.');
      router.replace(body.role === 'buyer' ? '/buyer/playground' : '/publisher/earnings');
      router.refresh();
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg.includes('popup-closed') ? 'The sign-in window was closed.' : msg);
      setBusy(false);
    }
  }

  return (
    <>
      <Button className="mt-6 w-full" onClick={signIn} disabled={busy || !config.apiKey}>
        {busy ? 'Signing in…' : 'Sign in with Google'}
      </Button>
      {!config.apiKey && <p className="mt-3 text-sm text-bad">Set NEXT_PUBLIC_FIREBASE_API_KEY, _AUTH_DOMAIN and _PROJECT_ID.</p>}
      {error && (
        <p role="alert" className="mt-4 text-[15px] text-bad">
          {error}
        </p>
      )}
    </>
  );
}
