/**
 * Period Management API Routes
 *
 * GET  /api/periods                - List all periods
 * GET  /api/periods/[id]           - Get period details (routed separately)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

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
    // Query all periods ordered by start date descending
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
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'PERIOD_LIST_ERROR',
        message: `Failed to list periods: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}
