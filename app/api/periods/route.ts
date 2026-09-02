/**
 * Period Management API Routes
 *
 * GET  /api/periods                - List all periods
 * GET  /api/periods/[id]           - Get period details (routed separately)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { purgeExpiredPeriods } from '@/lib/periodTrash';
import type { ApiSuccessResponse } from '@/types';

interface PeriodSummary {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
  pool_id: string;
}

/**
 * GET /api/periods - List all periods
 *
 * Returns array of periods with essential details
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    // Lazy sweep: there's no scheduler service in this deployment, so a
    // period past its 30-day trash retention gets purged the next time
    // anyone loads the periods list, rather than on a fixed schedule.
    purgeExpiredPeriods(auth!.userId);

    // Query all non-deleted periods ordered by start date descending
    const stmt = db.prepare(`
      SELECT
        id,
        naam,
        start_datum,
        eind_datum,
        deadline,
        status,
        pool_id
      FROM dienstrooster_schedule_period
      WHERE verwijderd_op IS NULL
      ORDER BY start_datum DESC
      LIMIT 100
    `);

    const rows = stmt.all() as Array<{
      id: string;
      naam: string;
      start_datum: string;
      eind_datum: string;
      deadline: string;
      status: string;
      pool_id: string;
    }>;

    const response: ApiSuccessResponse<PeriodSummary[]> = {
      success: true,
      data: rows,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('periods-list', error);
  }
}
