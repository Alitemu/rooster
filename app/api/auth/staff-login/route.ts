/**
 * Staff Login Route
 *
 * POST /api/auth/staff-login - Password (+TOTP if enrolled) login for ADMIN/PLANNER
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { verifyPassword, isValidTOTPFormat, verifyTOTPCode, DUMMY_PASSWORD_HASH } from '@/lib/auth';
import { setSessionCookie, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { checkRateLimit, getClientIp, recordAttempt, clearRateLimit, rateLimitedResponseBody } from '@/lib/rateLimit';

interface StaffLoginRequest {
  codenaam: string;
  password: string;
  totpCode?: string;
}

// 10 FAILED attempts per 15 minutes per account - enough for a human who
// fumbles a password or TOTP code a few times, tight enough that
// brute-forcing either is impractical. Successful logins deliberately
// don't count: every staff member shares one hospital NAT address, so
// counting them meant the 11th ordinary login of the afternoon was
// refused (see lib/rateLimit.ts).
//
// Counted per codenaam, not per client address alone: the whole hospital
// reaches this through one NAT address, so with a single per-address
// bucket anyone on the ward network could lock every planner out for 15
// minutes with ten wrong guesses at a made-up account. Now wrong guesses
// only count against the account they were aimed at. A second, wider
// per-address bucket still caps guessing spread over many codenamen.
const MAX_ATTEMPTS = 10;
const MAX_ATTEMPTS_PER_CLIENT = 50;

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await parseJsonBody<StaffLoginRequest>(req);
    const { codenaam, password, totpCode } = body;

    if (typeof codenaam !== 'string' || typeof password !== 'string' || !codenaam || !password) {
      return NextResponse.json(
        { success: false, error: { code: 'MISSING_FIELDS', message: 'Codenaam en wachtwoord zijn verplicht' } },
        { status: 400 }
      );
    }

    const clientIp = getClientIp(req);
    const clientKey = `staff-login-client:${clientIp}`;
    const rateLimitKey = `staff-login:${clientIp}:${codenaam.toLowerCase()}`;
    for (const [key, max] of [[rateLimitKey, MAX_ATTEMPTS], [clientKey, MAX_ATTEMPTS_PER_CLIENT]] as const) {
      const rateLimit = checkRateLimit(key, max);
      if (!rateLimit.allowed) {
        return NextResponse.json(rateLimitedResponseBody(rateLimit.retryAfterSeconds), { status: 429 });
      }
    }

    const invalidCredentials = () => {
      recordAttempt(rateLimitKey);
      recordAttempt(clientKey);
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Ongeldige inloggegevens' } },
        { status: 401 }
      );
    };

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
      if (typeof totpCode !== 'string' || !isValidTOTPFormat(totpCode)) {
        // Not counted: the password was right, this is the normal first
        // half of a two-step login, not a failed guess.
        return NextResponse.json(
          { success: false, error: { code: 'TOTP_REQUIRED', message: 'Authenticatiecode is verplicht' } },
          { status: 401 }
        );
      }
      if (!verifyTOTPCode(person.totp_secret, totpCode)) {
        return invalidCredentials();
      }
    }

    clearRateLimit(rateLimitKey);

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
      { kind: 'staff', personId: person.id, sessionVersion: getSessionVersion(person.id) ?? 1 },
      STAFF_SESSION_MAX_AGE_SECONDS
    );

    return response;
  } catch (error) {
    return internalErrorResponse('staff-login', error);
  }
}
