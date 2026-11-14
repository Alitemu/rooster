/**
 * GET /api/auth/me - Return the current authenticated identity, if any
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest } from '@/lib/auth-context';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = getAuthContextFromRequest(request);

  if (!auth) {
    return NextResponse.json({ success: true, data: { authenticated: false } });
  }

  // Only read for staff: a participant has no password to change.
  let tijdelijkWachtwoord = false;
  if (auth.role === 'ADMIN' || auth.role === 'PLANNER') {
    const row = db
      .prepare('SELECT wachtwoord_moet_wijzigen FROM dienstrooster_person WHERE id = ?')
      .get(auth.userId) as { wachtwoord_moet_wijzigen: number } | undefined;
    tijdelijkWachtwoord = Boolean(row?.wachtwoord_moet_wijzigen);
  }

  return NextResponse.json({
    success: true,
    data: {
      authenticated: true,
      person_id: auth.userId,
      role: auth.role,
      // Logged in with the public seed password: the login page asks for a new one first.
      wachtwoord_wijzigen: Boolean(auth.wachtwoordWijzigen),
      // Why: a temporary password an admin set, rather than the seed password.
      tijdelijk_wachtwoord: tijdelijkWachtwoord,
    },
  });
}
