// Live mode: anyone without a session cookie goes to /login. The cookie itself
// is verified on the server (lib/server/session.ts) on every page and action.
// The mode is the Demo/Live switch's cookie, else DATA_BACKEND (fixed if DATA_MODE_LOCKED=1).

import { NextResponse, type NextRequest } from 'next/server';

function liveMode(req: NextRequest): boolean {
  const byDefault = process.env.DATA_BACKEND === 'firestore';
  if (process.env.DATA_MODE_LOCKED === '1') return byDefault;
  const choice = req.cookies.get('fs_data')?.value;
  return choice ? choice === 'live' : byDefault;
}

export function middleware(req: NextRequest) {
  if (!liveMode(req)) return NextResponse.next();
  if (req.cookies.has('__session')) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  // Public: sign-in, the session route, the API reference and the OpenAPI document.
  matcher: ['/((?!login|api/session|docs|openapi\\.json|_next/|favicon).*)'],
};
