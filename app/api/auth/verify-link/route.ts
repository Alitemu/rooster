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
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

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
    let period: any;
    if (link.geldt_voor_periode_id) {
      period = db
        .prepare(`SELECT id, pool_id FROM dienstrooster_schedule_period WHERE id = ?`)
        .get(link.geldt_voor_periode_id);
    } else {
      period = db
        .prepare(
          `SELECT id, pool_id
           FROM dienstrooster_schedule_period
           WHERE status IN ('OPEN', 'GESLOTEN')
           ORDER BY start_datum DESC
           LIMIT 1`
        )
        .get();
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
