/**
 * Personal Link Verification Route
 *
 * GET /api/auth/verify-link?token=... - Verify access link and return person+period
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
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
          message: 'Access token is required',
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
          message: 'Invalid or expired access link',
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
          message: 'This access link has been revoked',
        },
      };
      return NextResponse.json(response, { status: 401 });
    }

    // Find current open period for this person's pool
    const periodStmt = db.prepare(`
      SELECT sp.id, sp.pool_id
      FROM dienstrooster_schedule_period sp
      WHERE sp.status IN ('OPEN', 'GESLOTEN')
      ORDER BY sp.start_datum DESC
      LIMIT 1
    `);

    const period = periodStmt.get() as any;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'NO_ACTIVE_PERIOD',
          message: 'No active scheduling period found',
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

    const response: ApiSuccessResponse<VerifyLinkResponse> = {
      success: true,
      data: {
        person_id: link.person_id,
        codenaam: link.codenaam,
        period_id: period.id,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'VERIFY_ERROR',
        message: `Failed to verify link: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}
