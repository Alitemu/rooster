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
 *
 * The codenaam being claimed ("planner") is NOT a secret - it's shown on
 * the login form and documented in scripts/seed.ts - so without something
 * else guarding this route, whoever reaches the app first after
 * deployment (not necessarily the real operator) would win the race to
 * claim the account, permanently locking the real operator out. The
 * setup_token (lib/setupToken.ts, printed once to the seed process's own
 * stdout - never sent over HTTP) is that something else.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { hashPassword, validatePasswordStrength } from '@/lib/auth';
import { verifySetupToken, clearSetupToken } from '@/lib/setupToken';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { checkRateLimit, getClientIp, rateLimitedResponseBody } from '@/lib/rateLimit';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface FirstRunSetupRequest {
  codenaam: string;
  password: string;
  setup_token: string;
}

// Generous but not unlimited - the token itself is a random 32-byte value
// (effectively unguessable), this is defense-in-depth against a flood of
// requests, matching staff-login's own rate limit.
const MAX_ATTEMPTS = 10;

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const rateLimit = checkRateLimit(`first-run-setup:${getClientIp(req)}`, MAX_ATTEMPTS);
    if (!rateLimit.allowed) {
      return NextResponse.json(rateLimitedResponseBody(rateLimit.retryAfterSeconds), { status: 429 });
    }

    const body = await parseJsonBody<FirstRunSetupRequest>(req);
    const { codenaam, password, setup_token } = body;

    // Checked before anything else, and before any DB lookup - a request
    // with a wrong/missing token gets the exact same response whether or
    // not the codenaam it named even exists or is still claimable, so it
    // learns nothing about account state either way.
    if (!verifySetupToken(setup_token)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_SETUP_TOKEN', message: 'Ongeldige of ontbrekende setup-token' },
      };
      return NextResponse.json(response, { status: 403 });
    }

    if (!codenaam || !password) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'Codenaam en wachtwoord zijn verplicht' },
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
        error: { code: 'SETUP_NOT_AVAILABLE', message: 'Dit account is niet beschikbaar voor eerste installatie' },
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
        error: { code: 'SETUP_NOT_AVAILABLE', message: 'Dit account is niet beschikbaar voor eerste installatie' },
      };
      return NextResponse.json(response, { status: 409 });
    }

    // Once nothing is left that the token could ever be used to claim,
    // remove it - eliminates any later use of a token that ends up in a
    // retained log file, and matches first-run-status's own "is anything
    // still pending" check.
    const stillPending = db
      .prepare(`SELECT 1 FROM dienstrooster_person WHERE rol IN ('ADMIN', 'PLANNER') AND wachtwoord_hash IS NULL`)
      .get();
    if (!stillPending) {
      clearSetupToken();
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
