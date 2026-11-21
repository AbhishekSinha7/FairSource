// Self-serve access for buildathon judges, on only while JUDGE_ACCESS=1.
//
// Anyone who signs in with Google and isn't linked to an organisation picks a side:
//   publisher -> joins JUDGE_PUBLISHER_ORG (default pub_example), the demo publisher with real content
//   buyer     -> gets their own buyer organisation (buy_judge_<hash>), so their API keys and usage are theirs
// The claims carry judge: true, so they can switch sides by signing in again, and
// `npx tsx infra/create-org.ts --project <id> --unlink-judges` removes every judge's access afterwards.
// Accounts linked with create-org (the team, real publishers and buyers) never see the choice.

import { createHash } from 'node:crypto';
import { adminAuth, adminDb } from './admin';
import type { Role } from './session';

export const JUDGE_ACCESS = process.env.JUDGE_ACCESS === '1';
export const JUDGE_PUBLISHER_ORG = process.env.JUDGE_PUBLISHER_ORG || 'pub_example';
/** Served tokens per month for each judge's buyer organisation. */
const JUDGE_BUYER_QUOTA_TOKENS = 2_000_000;

/** Whether this account gets the "explore as publisher or buyer" choice. */
export function mayChooseRole(claims: Record<string, unknown>): boolean {
  if (!JUDGE_ACCESS) return false;
  const linked = (claims.role === 'publisher' || claims.role === 'buyer') && typeof claims.orgId === 'string';
  return !linked || claims.judge === true;
}

export function judgeBuyerId(uid: string): string {
  return `buy_judge_${createHash('sha256').update(uid).digest('hex').slice(0, 12)}`;
}

/** Links a judge to the chosen side (creating their buyer organisation the first time). */
export async function linkJudge(uid: string, email: string | undefined, role: Role): Promise<string> {
  const db = adminDb();
  let orgId: string;
  if (role === 'publisher') {
    orgId = JUDGE_PUBLISHER_ORG;
    if (!(await db.collection('publishers').doc(orgId).get()).exists) throw new Error(`judge publisher ${orgId} doesn't exist`);
  } else {
    orgId = judgeBuyerId(uid);
    const who = email?.split('@')[0] ?? 'judge';
    try {
      // create() fails if it already exists, so a returning judge keeps their keys and usage.
      await db.collection('buyers').doc(orgId).create({
        name: `Judge sandbox (${who})`,
        country: 'IN',
        plan: 'judge',
        monthlyQuotaTokens: JUDGE_BUYER_QUOTA_TOKENS,
        usedTokensThisMonth: 0,
        status: 'active',
        createdAt: new Date(),
      });
    } catch (e) {
      if ((e as { code?: number }).code !== 6) throw e; // 6 = ALREADY_EXISTS
    }
  }
  await adminAuth().setCustomUserClaims(uid, { role, orgId, judge: true });
  return orgId;
}
