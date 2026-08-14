/**
 * Redirects unauthenticated requests away from planner/admin pages.
 *
 * This is a UX-level check only (session cookie presence) - Edge middleware
 * can't use Node's crypto module, so it can't verify the HMAC signature.
 * The actual signed-session verification and role check happens server-side
 * on every /api/planner and /api/periods request via lib/auth-context.ts;
 * that is the real security boundary. A visitor without a valid session who
 * gets past this redirect (e.g. with a forged cookie) still gets 401s from
 * every API call the page makes.
 */

import { NextRequest, NextResponse } from 'next/server';

// Duplicated from lib/session.ts (not imported) so this file has no
// dependency on Node's crypto module, which the Edge Runtime doesn't support.
const SESSION_COOKIE_NAME = 'dienstrooster_session';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith('/planner/login')) {
    return NextResponse.next();
  }

  const hasSession = request.cookies.has(SESSION_COOKIE_NAME);

  if (!hasSession) {
    const loginUrl = new URL('/planner/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/planner/:path*'],
};
