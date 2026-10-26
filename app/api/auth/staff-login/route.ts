/**
 * Staff Login Route
 *
 * POST /api/auth/staff-login - Password login for ADMIN/PLANNER
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { verifyPassword, DUMMY_PASSWORD_HASH } from '@/lib/auth';
import { setSessionCookie, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { seedPasswordMustBeChanged } from '@/lib/seedPassword';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { takeAttempt, releaseAttempt, getClientIp, clearRateLimit, rateLimitedResponseBody } from '@/lib/rateLimit';

interface StaffLoginRequest {
  codenaam: string;
  password: string;
}

// 10 FAILED attempts per 15 minutes per account - enough for a human who
// fumbles a password a few times, tight enough that
// brute-forcing it is impractical. Successful logins deliberately
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
    const { codenaam, password } = body;

    if (typeof codenaam !== 'string' || typeof password !== 'string' || !codenaam || !password) {
      return NextResponse.json(
        { success: false, error: { code: 'MISSING_FIELDS', message: 'Codenaam en wachtwoord zijn verplicht' } },
        { status: 400 }
      );
    }

    const clientIp = getClientIp(req);
    const clientKey = `staff-login-client:${clientIp}`;
    const rateLimitKey = `staff-login:${clientIp}:${codenaam.toLowerCase()}`;
    // Counted now, before the password is compared (lib/rateLimit.ts
    // takeAttempt); given back below after a successful login.
    const rateLimit = takeAttempt([
      [rateLimitKey, MAX_ATTEMPTS],
      [clientKey, MAX_ATTEMPTS_PER_CLIENT],
    ]);
    if (!rateLimit.allowed) {
      return NextResponse.json(rateLimitedResponseBody(rateLimit.retryAfterSeconds), { status: 429 });
    }
    const invalidCredentials = () => {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Ongeldige inloggegevens' } },
        { status: 401 }
      );
    };

    const person = db
      .prepare(
        `SELECT id, codenaam, rol, actief, wachtwoord_hash, wachtwoord_moet_wijzigen
         FROM dienstrooster_person
         WHERE codenaam = ? COLLATE NOCASE AND rol IN ('ADMIN', 'PLANNER')
         ORDER BY codenaam = ? DESC LIMIT 1`
      )
      .get(codenaam, codenaam) as
      | {
          id: string;
          codenaam: string;
          rol: 'ADMIN' | 'PLANNER';
          actief: number;
          wachtwoord_hash: string | null;
          wachtwoord_moet_wijzigen: number;
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

    clearRateLimit(rateLimitKey);
    releaseAttempt(clientKey);

    // The seed password is public with the code: a session opened with it
    // can only change the password (lib/auth-context.ts).
    // So can one opened with a temporary password an admin set
    // (/api/admin/accounts/[id]/reset-password): only its owner should
    // know the password the account goes on with.
    const tijdelijkWachtwoord = Boolean(person.wachtwoord_moet_wijzigen);
    const wachtwoordWijzigen = seedPasswordMustBeChanged(password) || tijdelijkWachtwoord;

    const response = NextResponse.json({
      success: true,
      data: {
        person_id: person.id,
        codenaam: person.codenaam,
        role: person.rol,
        wachtwoord_wijzigen: wachtwoordWijzigen,
        tijdelijk_wachtwoord: tijdelijkWachtwoord,
      },
    });

    setSessionCookie(
      response,
      {
        kind: 'staff',
        personId: person.id,
        sessionVersion: getSessionVersion(person.id) ?? 1,
        ...(wachtwoordWijzigen ? { wachtwoordWijzigen: true as const } : {}),
      },
      STAFF_SESSION_MAX_AGE_SECONDS
    );

    return response;
  } catch (error) {
    return internalErrorResponse('staff-login', error);
  }
}
