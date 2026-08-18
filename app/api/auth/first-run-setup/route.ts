/**
 * First-Run Setup: set the initial ADMIN/PLANNER password
 *
 * POST /api/auth/first-run-setup - set the password for one seeded staff
 * account that doesn't have one yet.
 *
 * Deliberately unauthenticated, like first-run-status - but the UPDATE
 * below is scoped to `wachtwoord_hash IS NULL`, so it only ever has an
 * effect once per account. Once a password is set this way (or any other
 * way), this route can no longer touch that account - it's a one-time
 * claim, not a password reset endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { hashPassword, validatePasswordStrength } from '@/lib/auth';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface FirstRunSetupRequest {
  codenaam: string;
  password: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await parseJsonBody<FirstRunSetupRequest>(req);
    const { codenaam, password } = body;

    if (!codenaam || !password) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'Codenaam and password are required' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const passwordErrors = validatePasswordStrength(password);
    if (passwordErrors.length > 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'WEAK_PASSWORD', message: passwordErrors.join(', ') },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const person = db
      .prepare(
        `SELECT id, wachtwoord_hash FROM dienstrooster_person
         WHERE codenaam = ? AND rol IN ('ADMIN', 'PLANNER')`
      )
      .get(codenaam) as { id: string; wachtwoord_hash: string | null } | undefined;

    // Same response whether the account doesn't exist or already has a
    // password - a caller probing which accounts are already claimed
    // learns nothing either way.
    if (!person || person.wachtwoord_hash !== null) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'SETUP_NOT_AVAILABLE', message: 'This account is not available for first-run setup' },
      };
      return NextResponse.json(response, { status: 409 });
    }

    const passwordHash = await hashPassword(password);

    const result = db
      .prepare(
        `UPDATE dienstrooster_person SET wachtwoord_hash = ?
         WHERE id = ? AND wachtwoord_hash IS NULL`
      )
      .run(passwordHash, person.id);

    // Someone else's request won the race between the SELECT and this
    // UPDATE (both unauthenticated, both racing the same NULL check).
    if (result.changes === 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'SETUP_NOT_AVAILABLE', message: 'This account is not available for first-run setup' },
      };
      return NextResponse.json(response, { status: 409 });
    }

    const response: ApiSuccessResponse<{ codenaam: string }> = {
      success: true,
      data: { codenaam },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('first-run-setup', error);
  }
}
