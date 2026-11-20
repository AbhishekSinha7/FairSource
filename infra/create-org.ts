// Creates a publisher or buyer organisation and links a Google account to it
// (custom claims role + orgId), so that person can sign in to the dashboard.
//
//   gcloud auth application-default login
//   npx tsx infra/create-org.ts --project fs-dev --role publisher --id pub_123 \
//     --name "Example Marathi Daily" --email editor@example.in --country IN --city Pune --languages mr,hi,en
//   npx tsx infra/create-org.ts --project fs-dev --role buyer --id buy_77 \
//     --name "Kavya AI" --email dev@kavya.ai --country IN --quota 10000000
//
// A publisher gets licence v1 (RAG, India, $0.002 per 1,000 tokens) and an Uploads source.
// Running it again for the same org is safe: existing documents are kept; the user's claims are updated.

import { newSource } from '@fairsource/shared';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    project: { type: 'string' },
    role: { type: 'string' },
    id: { type: 'string' },
    name: { type: 'string' },
    email: { type: 'string' },
    country: { type: 'string', default: 'IN' },
    city: { type: 'string' },
    languages: { type: 'string', default: 'mr,hi,en' },
    quota: { type: 'string', default: '10000000' },
  },
});

function need(v: string | undefined, flag: string): string {
  if (!v) {
    console.error(`Missing --${flag}. See the usage at the top of infra/create-org.ts.`);
    process.exit(1);
  }
  return v;
}

const project = need(a.project, 'project');
const role = need(a.role, 'role');
if (role !== 'publisher' && role !== 'buyer') need(undefined, 'role publisher|buyer');
const id = need(a.id, 'id');
if (!/^(pub|buy)_[a-z0-9_]{2,40}$/.test(id) || !id.startsWith(role === 'publisher' ? 'pub_' : 'buy_')) {
  console.error(`--id must look like ${role === 'publisher' ? 'pub_example' : 'buy_example'}`);
  process.exit(1);
}
const name = need(a.name, 'name');
const email = need(a.email, 'email').toLowerCase();

const app = getApps()[0] ?? initializeApp({ projectId: project });
const db = getFirestore(app);
const auth = getAuth(app);
const now = new Date();

if (role === 'publisher') {
  await db.collection('publishers').doc(id).set(
    {
      name,
      country: a.country,
      city: a.city ?? null,
      languages: a.languages!.split(',').map((s) => s.trim()).filter(Boolean),
      revenueSharePct: 75,
      payout: null,
      status: 'active',
      createdAt: now,
    },
    { merge: true },
  );
  const lic = db.collection('licences').doc(`lic_${id}_v1`);
  if (!(await lic.get()).exists) {
    await lic.set({ publisherId: id, uses: ['rag'], territories: ['IN'], pricePer1kTokensMicros: 2000, active: true, version: 1, createdAt: now });
    console.log('licence v1 created: rag / IN / $0.002 per 1,000 tokens');
  }
  const uploads = await db.collection('sources').where('publisherId', '==', id).where('type', '==', 'upload').limit(1).get();
  if (uploads.empty) {
    const srcId = `src_${id.slice(4)}_uploads`;
    await db.collection('sources').doc(srcId).set(newSource({ id: srcId, publisherId: id, type: 'upload', name: 'Uploads', url: null, consentAt: now }));
    console.log(`upload source ${srcId} created`);
  }
} else {
  await db.collection('buyers').doc(id).set(
    { name, country: a.country, plan: 'pilot', monthlyQuotaTokens: Number(a.quota), usedTokensThisMonth: 0, status: 'active', createdAt: now },
    { merge: true },
  );
}

let user;
try {
  user = await auth.getUserByEmail(email);
} catch {
  user = await auth.createUser({ email, emailVerified: false });
  console.log(`user ${email} created (signs in with Google)`);
}
await auth.setCustomUserClaims(user.uid, { role, orgId: id });
console.log(`${email} can now sign in as ${role} ${id} (${name}). If they were signed in, they must sign in again.`);
