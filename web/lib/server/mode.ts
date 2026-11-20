// Per-request data mode: the Demo/Live switch's cookie, else the server default.

import { cookies } from 'next/headers';
import { LIVE_DEFAULT, MODE_COOKIE, MODE_LOCKED } from './env';

export async function isLiveMode(): Promise<boolean> {
  if (MODE_LOCKED) return LIVE_DEFAULT;
  const choice = (await cookies()).get(MODE_COOKIE)?.value;
  return choice ? choice === 'live' : LIVE_DEFAULT;
}
