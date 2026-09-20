/**
 * POST /api/auth/totp/disable - Turn off TOTP for the logged-in staff account
 *
 * Until this existed, /api/auth/totp/confirm could turn 2FA on but nothing
 * could turn it back off - a lost or reset authenticator app permanently
 * locked the account out of password-only login, with no self-service way
 * back short of an UPDATE against the SQLite file. That is exactly the
 * scenario 2FA recovery has to handle, since "I can't produce a code
 * anymore" is the ordinary reason to disable it, not an edge case.
 *
 * Requires the current password, the same bar change-password sets for any
 * other change to how this account authenticates - proving "something you
 * know" is the only check that still makes sense once "something you have"
 * is exactly what's been lost. A fresh TOTP code is deliberately NOT
 * required in addition: that would defeat the one case this route exists
 * for.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { verifyPassword, DUMMY_PASSWORD_HASH } from '@/lib/auth';
import { getAuthContextFromRequest } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { checkRateLimit, recordAttempt, clearRateLimit, rateLimitedResponseBody } from '@/lib/rateLimit';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface DisableTotpRequest {
  wachtwoord: string;
}

// Same allowance as change-password: this route verifies a password too,
// so it is a second front door for guessing one. Only failures count.
const MAX_ATTEMPTS = 10;

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!auth || (auth.role !== 'ADMIN' && auth.role !== 'PLANNER')) {
      return unauthorizedResponse();
    }

    const rateLimitKey = `totp-disable:${auth.userId}`;
    const rateLimit = checkRateLimit(rateLimitKey, MAX_ATTEMPTS);
    if (!rateLimit.allowed) {
      return NextResponse.json(rateLimitedResponseBody(rateLimit.retryAfterSeconds), { status: 429 });
    }

    const body = await parseJsonBody<DisableTotpRequest>(req);
    const { wachtwoord } = body;

    if (!wachtwoord) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'Wachtwoord is verplicht' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const person = db
      .prepare('SELECT id, wachtwoord_hash, totp_secret FROM dienstrooster_person WHERE id = ?')
      .get(auth.userId) as { id: string; wachtwoord_hash: string | null; totp_secret: string | null } | undefined;

    // Same dummy-hash comparison as staff-login/change-password, so the
    // response time can't distinguish "no password set" from "wrong one".
    const passwordMatches = await verifyPassword(wachtwoord, person?.wachtwoord_hash ?? DUMMY_PASSWORD_HASH);
    if (!person || !person.wachtwoord_hash || !passwordMatches) {
      recordAttempt(rateLimitKey);
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_PASSWORD', message: 'Wachtwoord klopt niet' },
      };
      return NextResponse.json(response, { status: 401 });
    }

    if (!person.totp_secret) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'NOT_ENROLLED', message: 'Tweestapsverificatie staat al uit' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    clearRateLimit(rateLimitKey);

    db.prepare(
      `UPDATE dienstrooster_person SET totp_secret = NULL WHERE id = ?`
    ).run(person.id);

    // 'UPDATE', not a new actie value: actie has a fixed CHECK constraint
    // (see CLAUDE.md) - what happened is recorded in nieuw_json instead, the
    // same convention change-password uses for its own audit row.
    db.prepare(
      `INSERT INTO dienstrooster_audit_log
         (id, actor_id, entiteit, entiteit_id, actie, nieuw_json, tijdstip)
       VALUES (?, ?, 'person', ?, 'UPDATE', ?, ?)`
    ).run(
      crypto.randomUUID(),
      person.id,
      person.id,
      JSON.stringify({ wijziging: 'totp_uitgeschakeld' }),
      new Date().toISOString()
    );

    const response: ApiSuccessResponse<{ disabled: true }> = {
      success: true,
      data: { disabled: true },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('totp-disable', error);
  }
}
