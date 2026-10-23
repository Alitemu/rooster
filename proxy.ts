/**
 * Two jobs.
 *
 * 1. Refuses a request that changes something (not GET, HEAD or OPTIONS) when
 *    it comes from a page of another site, or is a form-type body: the
 *    cookie's SameSite=Lax is not enough against a page on the same address
 *    with another port or name (lib/crossSite.ts).
 * 2. Redirects unauthenticated requests away from planner/admin pages.
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
import { isCrossSiteRequest, isSimpleFormContentType } from '@/lib/crossSite';

// Duplicated from lib/session.ts (not imported) so this file has no
// dependency on Node's crypto module, which the Edge Runtime doesn't support.
const SESSION_COOKIE_NAME = 'dienstrooster_session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function refusal(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith('/api/')) {
    if (SAFE_METHODS.has(request.method)) return NextResponse.next();
    if (isCrossSiteRequest(request.headers)) {
      return refusal(403, 'CROSS_SITE', 'Dit verzoek komt niet van deze website en is niet uitgevoerd.');
    }
    if (isSimpleFormContentType(request.headers.get('content-type'))) {
      return refusal(415, 'UNSUPPORTED_MEDIA_TYPE', 'Dit verzoek heeft een ongeldig type en is niet uitgevoerd.');
    }
    return NextResponse.next();
  }

  if (pathname.startsWith('/planner/login')) {
    return NextResponse.next();
  }

  const hasSession = request.cookies.has(SESSION_COOKIE_NAME);

  if (!hasSession) {
    // A clone of nextUrl keeps the app's sub-folder (next.config basePath)
    // in front of the new path; pathname itself is without it.
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/planner/login';
    loginUrl.search = '';
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/planner/:path*', '/api/:path*'],
};
