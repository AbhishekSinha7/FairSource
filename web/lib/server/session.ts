// Who is signed in. Firebase Auth session cookie with custom claims
// { role: 'publisher' | 'buyer', orgId } set by infra/create-org.ts.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { adminAuth, adminDb } from './admin';
import { SESSION_COOKIE } from './env';
import { isLiveMode } from './mode';

export type Role = 'publisher' | 'buyer';

export interface Session {
  uid: string;
  email: string | null;
  role: Role;
  orgId: string;
}

export interface OrgInfo {
  name: string;
  subtitle: string;
}

/** The signed-in user, or null (also null in demo mode). */
export async function currentSession(): Promise<Session | null> {
  if (!(await isLiveMode())) return null;
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) return null;
  try {
    const c = await adminAuth().verifySessionCookie(cookie, true);
    if ((c.role !== 'publisher' && c.role !== 'buyer') || typeof c.orgId !== 'string') return null;
    return { uid: c.uid, email: c.email ?? null, role: c.role, orgId: c.orgId };
  } catch {
    return null;
  }
}

/** For pages and actions: the session for this role, or a redirect. */
export async function requireSession(role: Role): Promise<Session> {
  const s = await currentSession();
  if (!s) redirect('/login');
  if (s.role !== role) redirect(s.role === 'publisher' ? '/publisher/earnings' : '/buyer/playground');
  return s;
}

const LANGUAGE_NAMES: Record<string, string> = { mr: 'Marathi', hi: 'Hindi', en: 'English', gu: 'Gujarati', kn: 'Kannada', ta: 'Tamil', te: 'Telugu', bn: 'Bengali' };
export const languageName = (code: string) => LANGUAGE_NAMES[code] ?? code;

export async function orgInfo(s: Session): Promise<OrgInfo> {
  const snap = await adminDb().collection(s.role === 'publisher' ? 'publishers' : 'buyers').doc(s.orgId).get();
  const d = snap.data() ?? {};
  if (s.role === 'publisher') {
    const langs = ((d.languages as string[] | undefined) ?? []).map(languageName).join(', ');
    return { name: String(d.name ?? s.orgId), subtitle: [d.city, langs].filter(Boolean).join(' · ') || String(d.country ?? '') };
  }
  const quota = Number(d.monthlyQuotaTokens ?? 0);
  return { name: String(d.name ?? s.orgId), subtitle: `${d.country ?? ''} · ${quota >= 1e6 ? `${quota / 1e6}M` : quota} tokens a month` };
}
