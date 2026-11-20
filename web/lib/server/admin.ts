// Firebase Admin, server side only. Credentials come from the App Hosting
// service account (or `gcloud auth application-default login` locally).

import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

let db: Firestore | null = null;

function app() {
  return getApps()[0] ?? initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID });
}

export function adminDb(): Firestore {
  if (!db) {
    db = getFirestore(app());
    db.settings({ ignoreUndefinedProperties: true });
  }
  return db;
}

export const adminAuth = () => getAuth(app());

/** Firestore Timestamps -> Date, recursively. */
export function revive<T>(v: unknown): T {
  if (v instanceof Timestamp) return v.toDate() as T;
  if (Array.isArray(v)) return v.map(revive) as T;
  if (v && typeof v === 'object' && v.constructor === Object) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)])) as T;
  return v as T;
}
