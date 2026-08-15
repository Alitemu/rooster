/**
 * Staff Login Route
 *
 * POST /api/auth/staff-login - Password (+TOTP if enrolled) login for ADMIN/PLANNER
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { verifyPassword, isValidTOTPFormat, verifyTOTPCode } from '@/lib/auth';
import { setSessionCookie, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';

interface StaffLoginRequest {
  codenaam: string;
  password: string;
  totpCode?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await parseJsonBody<StaffLoginRequest>(req);
    const { codenaam, password, totpCode } = body;

    if (!codenaam || !password) {
      return NextResponse.json(
        { success: false, error: { code: 'MISSING_FIELDS', message: 'Codenaam and password are required' } },
        { status: 400 }
      );
    }

    const invalidCredentials = () =>
      NextResponse.json(
        { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' } },
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
      return invalidCredentials();
    }

    const passwordOk = await verifyPassword(password, person.wachtwoord_hash);
    if (!passwordOk) {
      return invalidCredentials();
    }

    if (person.totp_secret) {
      if (!totpCode || !isValidTOTPFormat(totpCode)) {
        return NextResponse.json(
          { success: false, error: { code: 'TOTP_REQUIRED', message: 'Authentication code is required' } },
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
      { kind: 'staff', personId: person.id, role: person.rol },
      STAFF_SESSION_MAX_AGE_SECONDS
    );

    return response;
  } catch (error) {
    return internalErrorResponse('staff-login', error);
  }
}
