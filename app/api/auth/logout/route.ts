/**
 * POST /api/auth/logout - End the session (person or staff)
 *
 * Clears the cookie in this browser and, by default, revokes every other
 * session issued for the same person (lib/sessionVersion.ts).
 *
 * Revoking by default rather than on request: on a shared ward computer,
 * "log out" is the gesture someone makes precisely because they are about
 * to walk away from it, and clearing one browser's cookie while a copy
 * elsewhere stays valid for another 30 days is not what that gesture
 * means. Pass `{ "alleenDezeBrowser": true }` to only drop this one - for
 * a personal device where staying logged in on your phone is the point.
 */

import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/session';
import { getAuthContextFromRequest } from '@/lib/auth-context';
import { revokeAllSessions } from '@/lib/sessionVersion';
import { parseJsonBody } from '@/lib/api-errors';

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Clearing this browser's cookie comes first and is never conditional.
  // Revoking the other sessions is the better outcome, but if anything
  // about it fails, the one thing someone pressing "Uitloggen" is entitled
  // to - being signed out here - must still happen. An error response
  // would leave them logged in on the machine they are walking away from.
  const response = NextResponse.json({ success: true, data: { loggedOut: true } });
  clearSessionCookie(response);

  try {
    const auth = getAuthContextFromRequest(req);

    // An empty body is the normal case - the UI posts nothing.
    const body = await parseJsonBody<{ alleenDezeBrowser?: boolean }>(req);
    const alleenDezeBrowser = body.alleenDezeBrowser === true;

    if (auth && !alleenDezeBrowser) {
      revokeAllSessions(auth.userId);
    }
  } catch (error) {
    console.error('[logout] intrekken van de overige sessies mislukt', error);
  }

  return response;
}
