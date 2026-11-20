// Per-request data mode: the Demo/Live switch's cookie, else the server default.

import { cookies, headers } from 'next/headers';
import { LIVE_DEFAULT, MODE_COOKIE, MODE_LOCKED } from './env';

const SHARED_HOST = (() => {
  try {
    return process.env.NEXT_PUBLIC_FAIRSOURCE_URL ? new URL(process.env.NEXT_PUBLIC_FAIRSOURCE_URL).host : null;
  } catch {
    return null;
  }
})();

/**
 * True when the request came through the shared address (Firebase Hosting). Hosting
 * forwards only the __session cookie, so the Demo/Live switch's cookie never arrives:
 * there the dashboard is always Live and the switch is hidden.
 */
export async function viaSharedUrl(): Promise<boolean> {
  if (!SHARED_HOST) return false;
  const h = await headers();
  return h.get('x-forwarded-host') === SHARED_HOST || h.get('host') === SHARED_HOST;
}

/** Whether the Demo/Live switch can be used on this request. */
export async function modeSwitchAvailable(): Promise<boolean> {
  return !MODE_LOCKED && !(await viaSharedUrl());
}

export async function isLiveMode(): Promise<boolean> {
  if (MODE_LOCKED) return LIVE_DEFAULT;
  if (await viaSharedUrl()) return true;
  const choice = (await cookies()).get(MODE_COOKIE)?.value;
  return choice ? choice === 'live' : LIVE_DEFAULT;
}
