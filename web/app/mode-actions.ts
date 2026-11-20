'use server';

// The sidebar's Demo data / Live data switch. Stored per browser in a cookie.

import { cookies } from 'next/headers';
import { MODE_COOKIE, MODE_LOCKED } from '@/lib/server/env';

export async function setDataMode(mode: 'demo' | 'live'): Promise<void> {
  if (MODE_LOCKED) return; // production: the mode is fixed by DATA_BACKEND
  (await cookies()).set(MODE_COOKIE, mode === 'live' ? 'live' : 'demo', {
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 180,
  });
}
