/**
 * Personal Link Verification Route
 *
 * GET /api/auth/verify-link?token=... - Verify access link and return person+period
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { setSessionCookie, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { internalErrorResponse } from '@/lib/api-errors';
import { checkRateLimit, getClientIp, recordAttempt, rateLimitedResponseBody } from '@/lib/rateLimit';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

// A personal-link token is the only access control a participant has, so
// guessing one is the more dangerous brute-force target here - a bigger
// allowance than staff-login (30 vs 10 per window) still makes guessing a
// long random token infeasible while tolerating a mistyped/partial paste.
//
// Counts only rejected tokens. Every page load of /person/[token] calls
// this route, and the whole ward shares one NAT address, so counting
// successful verifications meant a batch of reminder emails could exhaust
// the allowance within minutes of being sent - and the participant page
// shows a 429 as "Ongeldige of verlopen toegangslink" (see
// app/person/[token]/page.tsx), i.e. exactly the wrong advice.
const MAX_ATTEMPTS = 30;

interface VerifyLinkResponse {
  person_id: string;
  codenaam: string;
  period_id: string;
}

/**
 * GET /api/auth/verify-link - Verify personal access link
 *
 * Returns person_id and current period_id if token is valid
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const rateLimitKey = `verify-link:${getClientIp(req)}`;
    const rateLimit = checkRateLimit(rateLimitKey, MAX_ATTEMPTS);
    if (!rateLimit.allowed) {
      return NextResponse.json(rateLimitedResponseBody(rateLimit.retryAfterSeconds), { status: 429 });
    }

    const { searchParams } = new URL(req.url);
    const token = searchParams.get('token');

    if (!token) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_TOKEN',
          message: 'Toegangstoken is verplicht',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Hash token to match DB
    const tokenHash = hashToken(token);

    // Look up access link
    const linkStmt = db.prepare(`
      SELECT
        pal.person_id,
        pal.ingetrokken_op,
        pal.geldt_voor_periode_id,
        p.codenaam
      FROM dienstrooster_person_access_link pal
      JOIN dienstrooster_person p ON p.id = pal.person_id
      WHERE pal.token_hash = ?
    `);

    const link = linkStmt.get(tokenHash) as any;

    if (!link) {
      recordAttempt(rateLimitKey);
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_TOKEN',
          message: 'Ongeldige of verlopen toegangslink',
        },
      };
      return NextResponse.json(response, { status: 401 });
    }

    // Check if token was revoked
    if (link.ingetrokken_op) {
      recordAttempt(rateLimitKey);
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'TOKEN_REVOKED',
          message: 'Deze toegangslink is ingetrokken',
        },
      };
      return NextResponse.json(response, { status: 401 });
    }

    // A link created for a specific period (the normal case) always resolves
    // to that period, whatever its status - the person needs to reach their
    // preferences UI before publication and their roster after. Only a
    // general link with no period (geldt_voor_periode_id IS NULL) falls back
    // to auto-detecting the current enrollment period.
    //
    // A period in the trash (verwijderd_op set) is excluded in both
    // branches: it is on its way to being purged, and sending someone to
    // fill in preferences for it would mean their work disappears with it.
    // The link is not retired for that - restoring the period brings it
    // back - so this only has to stop resolving while it sits in the trash.
    let period: any;
    if (link.geldt_voor_periode_id) {
      period = db
        .prepare(
          `SELECT id, pool_id FROM dienstrooster_schedule_period
           WHERE id = ? AND verwijderd_op IS NULL`
        )
        .get(link.geldt_voor_periode_id);
    } else {
      // A general link with no period of its own only auto-detects within
      // the pools this person actually belongs to - otherwise, as soon as a
      // second pool exists, it would hand them whichever period happens to
      // be the most recent one in the whole database.
      period = db
        .prepare(
          `SELECT sp.id, sp.pool_id
           FROM dienstrooster_schedule_period sp
           JOIN dienstrooster_pool_membership pm
             ON pm.pool_id = sp.pool_id
            AND pm.person_id = ?
            AND pm.geldig_vanaf <= sp.eind_datum
            AND pm.geldig_tot >= sp.start_datum
           WHERE sp.status IN ('OPEN', 'GESLOTEN')
             AND sp.verwijderd_op IS NULL
           ORDER BY sp.start_datum DESC
           LIMIT 1`
        )
        .get(link.person_id);
    }

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'NO_ACTIVE_PERIOD',
          message: 'Geen actieve roosterperiode gevonden',
        },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Update last used timestamp
    const updateStmt = db.prepare(`
      UPDATE dienstrooster_person_access_link
      SET laatst_gebruikt_op = ?
      WHERE token_hash = ?
    `);

    updateStmt.run(new Date().toISOString(), tokenHash);

    const responseBody: ApiSuccessResponse<VerifyLinkResponse> = {
      success: true,
      data: {
        person_id: link.person_id,
        codenaam: link.codenaam,
        period_id: period.id,
      },
    };

    const response = NextResponse.json(responseBody);
    setSessionCookie(
      response,
      { kind: 'person', personId: link.person_id },
      PERSON_SESSION_MAX_AGE_SECONDS
    );

    return response;
  } catch (error) {
    return internalErrorResponse('verify-link', error);
  }
}
