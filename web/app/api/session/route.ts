// Exchanges a fresh Firebase ID token for an httpOnly session cookie (5 days),
// and clears it on sign-out. The cookie carries the role and orgId claims.
//
// With JUDGE_ACCESS=1, an account that isn't linked to an organisation gets
// { error: 'choose_role' } and posts again with as: 'publisher' | 'buyer'. The server
// links it, answers { error: 'refresh_token' }, and the client posts a refreshed token
// (which now carries the new claims) to get its session. See lib/server/judge.ts.

import { NextResponse, type NextRequest } from 'next/server';
import { adminAuth } from '@/lib/server/admin';
import { SESSION_COOKIE } from '@/lib/server/env';
import { linkJudge, mayChooseRole } from '@/lib/server/judge';

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  const { idToken, as } = (await req.json().catch(() => ({}))) as { idToken?: string; as?: string };
  if (!idToken) return NextResponse.json({ error: 'missing_token' }, { status: 400 });
  try {
    const decoded = await adminAuth().verifyIdToken(idToken, true);
    if (Date.now() / 1000 - decoded.auth_time > 5 * 60) return NextResponse.json({ error: 'stale_sign_in', message: 'Please sign in again.' }, { status: 401 });

    if (mayChooseRole(decoded)) {
      if (as !== 'publisher' && as !== 'buyer') return NextResponse.json({ error: 'choose_role' }, { status: 409 });
      if (decoded.role !== as || decoded.judge !== true) {
        await linkJudge(decoded.uid, decoded.email, as);
        return NextResponse.json({ error: 'refresh_token' }, { status: 409 });
      }
    }

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
  } catch (e) {
    console.error(JSON.stringify({ severity: 'ERROR', event: 'sign_in_failed', message: (e as Error).message }));
    return NextResponse.json({ error: 'invalid_token', message: 'Sign-in failed. Please try again.' }, { status: 401 });
  }
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
