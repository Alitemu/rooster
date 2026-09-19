/**
 * POST /api/auth/change-password - change your own staff password
 *
 * Until this existed, a planner password could only ever be set once:
 * /api/auth/first-run-setup claims an account that still has
 * `wachtwoord_hash IS NULL` and then can never touch it again. That was
 * fine while the password was a known test value set by the seed - it is
 * not fine the moment a real ward uses this, because the one password
 * controlling the entire roster is a password checked into git that no
 * screen in the application can change. Changing it meant an UPDATE by
 * hand against the SQLite file.
 *
 * Requires the current password, even though the caller is already
 * authenticated: without it, an unattended logged-in session (the ward
 * computer someone walked away from) is enough to lock the real planner
 * out of their own account.
 *
 * On success every other session for this account is revoked and this
 * browser gets a fresh cookie, so changing the password after a suspected
 * leak actually ends the leaked session instead of leaving it valid for
 * the rest of its 12 hours.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { hashPassword, verifyPassword, validatePasswordStrength, DUMMY_PASSWORD_HASH } from '@/lib/auth';
import { setSessionCookie, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { revokeAllSessions } from '@/lib/sessionVersion';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { checkRateLimit, recordAttempt, clearRateLimit, rateLimitedResponseBody } from '@/lib/rateLimit';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface ChangePasswordRequest {
  huidig_wachtwoord: string;
  nieuw_wachtwoord: string;
}

// Same allowance as staff-login: this route verifies a password too, so it
// is a second front door for guessing one. Only failures count.
const MAX_ATTEMPTS = 10;

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    // Keyed on the account, not the client address: everyone here shares
    // one NAT address, and this route can only ever target the caller's
    // own account anyway.
    const rateLimitKey = `change-password:${auth!.userId}`;
    const rateLimit = checkRateLimit(rateLimitKey, MAX_ATTEMPTS);
    if (!rateLimit.allowed) {
      return NextResponse.json(rateLimitedResponseBody(rateLimit.retryAfterSeconds), { status: 429 });
    }

    const body = await parseJsonBody<ChangePasswordRequest>(req);
    const { huidig_wachtwoord, nieuw_wachtwoord } = body;

    if (!huidig_wachtwoord || !nieuw_wachtwoord) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'Huidig en nieuw wachtwoord zijn verplicht' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const person = db
      .prepare('SELECT id, wachtwoord_hash FROM dienstrooster_person WHERE id = ?')
      .get(auth!.userId) as { id: string; wachtwoord_hash: string | null } | undefined;

    // Compares against a dummy hash when the account has none, so the
    // response time does not distinguish "no password set" from "wrong
    // password" - same reasoning as staff-login.
    const currentMatches = await verifyPassword(
      huidig_wachtwoord,
      person?.wachtwoord_hash ?? DUMMY_PASSWORD_HASH
    );
    if (!person || !person.wachtwoord_hash || !currentMatches) {
      recordAttempt(rateLimitKey);
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_PASSWORD', message: 'Huidig wachtwoord klopt niet' },
      };
      return NextResponse.json(response, { status: 401 });
    }

    const passwordErrors = validatePasswordStrength(nieuw_wachtwoord);
    if (passwordErrors.length > 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'WEAK_PASSWORD', message: passwordErrors.join(', ') },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (nieuw_wachtwoord === huidig_wachtwoord) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PASSWORD_UNCHANGED',
          message: 'Het nieuwe wachtwoord moet verschillen van het huidige',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const newHash = await hashPassword(nieuw_wachtwoord);
    db.prepare('UPDATE dienstrooster_person SET wachtwoord_hash = ? WHERE id = ?').run(newHash, person.id);

    // Ends every session issued before this moment, including any the old
    // password was used to open elsewhere.
    const newSessionVersion = revokeAllSessions(person.id);

    clearRateLimit(rateLimitKey);

    // 'UPDATE' rather than a new action value: `actie` has a CHECK
    // constraint listing the ten allowed actions, and what happened is
    // recorded in nieuw_json instead. Deliberately no password material of
    // any kind, not even its length.
    db.prepare(
      `INSERT INTO dienstrooster_audit_log
         (id, actor_id, entiteit, entiteit_id, actie, nieuw_json, tijdstip)
       VALUES (?, ?, 'person', ?, 'UPDATE', ?, ?)`
    ).run(
      crypto.randomUUID(),
      person.id,
      person.id,
      JSON.stringify({ wijziging: 'wachtwoord', sessies_ingetrokken: true }),
      new Date().toISOString()
    );

    const responseBody: ApiSuccessResponse<{ changed: true }> = {
      success: true,
      data: { changed: true },
    };
    const response = NextResponse.json(responseBody);

    // Re-issue this browser's cookie at the new version - the person who
    // just typed both passwords should not be logged out by their own
    // change.
    setSessionCookie(
      response,
      { kind: 'staff', personId: person.id, sessionVersion: newSessionVersion },
      STAFF_SESSION_MAX_AGE_SECONDS
    );

    return response;
  } catch (error) {
    return internalErrorResponse('change-password', error);
  }
}
