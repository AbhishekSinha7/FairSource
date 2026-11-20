// Exchanges a fresh Firebase ID token for an httpOnly session cookie (5 days),
// and clears it on sign-out. The cookie carries the role and orgId claims.

import { NextResponse, type NextRequest } from 'next/server';
import { adminAuth } from '@/lib/server/admin';
import { SESSION_COOKIE } from '@/lib/server/env';

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  const { idToken } = (await req.json().catch(() => ({}))) as { idToken?: string };
  if (!idToken) return NextResponse.json({ error: 'missing_token' }, { status: 400 });
  try {
    const decoded = await adminAuth().verifyIdToken(idToken, true);
    if (Date.now() / 1000 - decoded.auth_time > 5 * 60) return NextResponse.json({ error: 'stale_sign_in', message: 'Please sign in again.' }, { status: 401 });
    if ((decoded.role !== 'publisher' && decoded.role !== 'buyer') || typeof decoded.orgId !== 'string') {
      return NextResponse.json(
        { error: 'no_organisation', message: `${decoded.email ?? 'This account'} isn't linked to a publisher or buyer yet. Ask the FairSource team to add you.` },
        { status: 403 },
      );
    }
    const cookie = await adminAuth().createSessionCookie(idToken, { expiresIn: FIVE_DAYS_MS });
    const res = NextResponse.json({ ok: true, role: decoded.role });
    res.cookies.set(SESSION_COOKIE, cookie, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: FIVE_DAYS_MS / 1000 });
    return res;
  } catch {
    return NextResponse.json({ error: 'invalid_token', message: 'Sign-in failed. Please try again.' }, { status: 401 });
  }
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
