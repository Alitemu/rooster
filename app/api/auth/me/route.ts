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

  // Only meaningful for staff (only ADMIN/PLANNER ever get a totp_secret -
  // see /api/auth/totp/confirm) - the TOTP settings dialog is the one
  // consumer, and it never opens for a DEELNEMER session in the first
  // place, so this is read for staff only rather than adding a column read
  // that means nothing for a participant.
  let totpEnrolled = false;
  if (auth.role === 'ADMIN' || auth.role === 'PLANNER') {
    const row = db
      .prepare('SELECT totp_secret FROM dienstrooster_person WHERE id = ?')
      .get(auth.userId) as { totp_secret: string | null } | undefined;
    totpEnrolled = Boolean(row?.totp_secret);
  }

  return NextResponse.json({
    success: true,
    data: {
      authenticated: true,
      person_id: auth.userId,
      role: auth.role,
      totp_enrolled: totpEnrolled,
      // Logged in with the public seed password: the login page asks for a new one first.
      wachtwoord_wijzigen: Boolean(auth.wachtwoordWijzigen),
    },
  });
}
