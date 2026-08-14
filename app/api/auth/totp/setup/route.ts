/**
 * POST /api/auth/totp/setup - Begin TOTP enrollment for the logged-in staff account
 *
 * Requires an existing staff session (password login). Generates a new
 * secret and returns a QR code plus a short-lived signed setup token; the
 * secret is only persisted once confirmed via /api/auth/totp/confirm, so a
 * staff member who never scans the QR code doesn't get locked out.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { generateTOTPSecret } from '@/lib/auth';
import { getAuthContextFromRequest } from '@/lib/auth-context';
import { signPayload } from '@/lib/session';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';

export interface TotpSetupPayload {
  kind: 'totp-setup';
  personId: string;
  secret: string;
}

const SETUP_TOKEN_MAX_AGE_SECONDS = 60 * 10;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!auth || (auth.role !== 'ADMIN' && auth.role !== 'PLANNER')) {
      return unauthorizedResponse();
    }

    const person = db
      .prepare(`SELECT codenaam FROM dienstrooster_person WHERE id = ?`)
      .get(auth.userId) as { codenaam: string } | undefined;

    if (!person) {
      return unauthorizedResponse();
    }

    const { secret, qrCode } = generateTOTPSecret(person.codenaam);

    const setupToken = signPayload<TotpSetupPayload>(
      { kind: 'totp-setup', personId: auth.userId, secret },
      SETUP_TOKEN_MAX_AGE_SECONDS
    );

    return NextResponse.json({
      success: true,
      data: { setup_token: setupToken, qr_code: qrCode, secret },
    });
  } catch (error) {
    return internalErrorResponse('totp-setup', error);
  }
}
