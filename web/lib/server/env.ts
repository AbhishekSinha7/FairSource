// Which data the dashboard shows.
//   Demo data -> lib/mock.ts, no sign-in: for the pitch and offline work.
//   Live data -> real data for the signed-in organisation (Firestore + Firebase Auth).
// DATA_BACKEND=firestore makes live the default; the sidebar's Demo/Live switch
// overrides it per browser (cookie), unless DATA_MODE_LOCKED=1 (production).
export const LIVE_DEFAULT = process.env.DATA_BACKEND === 'firestore';
export const MODE_LOCKED = process.env.DATA_MODE_LOCKED === '1';
export const MODE_COOKIE = 'fs_data';

/** Live mode needs the Firebase web config (and server credentials for Firestore). */
export const LIVE_CONFIGURED = !!(process.env.NEXT_PUBLIC_FIREBASE_API_KEY && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID);

export const SESSION_COOKIE = '__session'; // the only cookie Firebase App Hosting forwards

export const INGEST_URL = (process.env.INGEST_URL ?? 'http://localhost:8098').replace(/\/$/, '');
export const API_URL = (process.env.API_URL ?? 'http://localhost:8097').replace(/\/$/, '');
export const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? '';
export const REPORTING_TIME_ZONE = 'Asia/Kolkata';
