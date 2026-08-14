/**
 * Period Detail API Route
 *
 * GET  /api/periods/[id]  - Get detailed period information
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface PeriodDetail {
  id: string;
  pool_id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
  bevroren_ruleset_json: string | null;
  overloop_bevestigd_op: string | null;
  row_version: number;
}

/**
 * GET /api/periods/[id] - Get period details
 *
 * Returns full period information including frozen ruleset and confirmation status
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;

    // Validate ID format
    if (!id || typeof id !== 'string') {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_PERIOD_ID',
          message: 'Period ID must be a valid string',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const stmt = db.prepare(`
      SELECT
        id,
        pool_id,
        naam,
        start_datum,
        eind_datum,
        deadline,
        status,
        bevroren_ruleset_json,
        overloop_bevestigd_op,
        row_version
      FROM dienstrooster_schedule_period
      WHERE id = ?
    `);

    const row = stmt.get(id) as PeriodDetail | undefined;

    if (!row) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PERIOD_NOT_FOUND',
          message: `Period with ID ${id} not found`,
        },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const response: ApiSuccessResponse<PeriodDetail> = {
      success: true,
      data: row,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-detail', error);
  }
}
