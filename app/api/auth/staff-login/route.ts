/**
 * Staff Login Route
 *
 * POST /api/auth/staff-login - Password (+TOTP if enrolled) login for ADMIN/PLANNER
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { verifyPassword, isValidTOTPFormat, verifyTOTPCode, DUMMY_PASSWORD_HASH } from '@/lib/auth';
import { setSessionCookie, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { checkRateLimit, getClientIp, rateLimitedResponseBody } from '@/lib/rateLimit';

interface StaffLoginRequest {
  codenaam: string;
  password: string;
  totpCode?: string;
}

// 10 attempts per 15 minutes per client IP - enough for a human who
// fumbles a password or TOTP code a few times, tight enough that
// brute-forcing either is impractical.
const MAX_ATTEMPTS = 10;

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const rateLimit = checkRateLimit(`staff-login:${getClientIp(req)}`, MAX_ATTEMPTS);
    if (!rateLimit.allowed) {
      return NextResponse.json(rateLimitedResponseBody(rateLimit.retryAfterSeconds), { status: 429 });
    }

    const body = await parseJsonBody<StaffLoginRequest>(req);
    const { codenaam, password, totpCode } = body;

    if (!codenaam || !password) {
      return NextResponse.json(
        { success: false, error: { code: 'MISSING_FIELDS', message: 'Codenaam en wachtwoord zijn verplicht' } },
        { status: 400 }
      );
    }

    const invalidCredentials = () =>
      NextResponse.json(
        { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Ongeldige inloggegevens' } },
        { status: 401 }
      );

    const person = db
      .prepare(
        `SELECT id, codenaam, rol, actief, wachtwoord_hash, totp_secret
         FROM dienstrooster_person
         WHERE codenaam = ? AND rol IN ('ADMIN', 'PLANNER')`
      )
      .get(codenaam) as
      | {
          id: string;
          codenaam: string;
          rol: 'ADMIN' | 'PLANNER';
          actief: number;
          wachtwoord_hash: string | null;
          totp_secret: string | null;
        }
      | undefined;

    if (!person || !person.actief || !person.wachtwoord_hash) {
      // Pay the same bcrypt.compare cost as the real-account path so an
      // unknown/deactivated codenaam can't be distinguished from a wrong
      // password purely by how fast the response comes back.
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      return invalidCredentials();
    }

    const passwordOk = await verifyPassword(password, person.wachtwoord_hash);
    if (!passwordOk) {
      return invalidCredentials();
    }

    if (person.totp_secret) {
      if (!totpCode || !isValidTOTPFormat(totpCode)) {
        return NextResponse.json(
          { success: false, error: { code: 'TOTP_REQUIRED', message: 'Authenticatiecode is verplicht' } },
          { status: 401 }
        );
      }
      if (!verifyTOTPCode(person.totp_secret, totpCode)) {
        return invalidCredentials();
      }
    }

    const response = NextResponse.json({
      success: true,
      data: {
        person_id: person.id,
        codenaam: person.codenaam,
        role: person.rol,
        totp_enrolled: Boolean(person.totp_secret),
      },
    });

    setSessionCookie(
      response,
      { kind: 'staff', personId: person.id },
      STAFF_SESSION_MAX_AGE_SECONDS
    );

    return response;
  } catch (error) {
    return internalErrorResponse('staff-login', error);
  }
}
