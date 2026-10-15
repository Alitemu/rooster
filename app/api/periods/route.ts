/**
 * Period Management API Routes
 *
 * GET  /api/periods                - List all periods
 * GET  /api/periods/[id]           - Get period details (routed separately)
 */

import { getActivePeriods } from '@/lib/activePeriod';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { visibleDienst } from '@/lib/dienstAccess';
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

    // Every non-deleted period of the planner's own dienst (a beheerder:
    // every dienst, lib/dienstAccess.ts), newest first.
    const dienst = visibleDienst(auth!);
    const stmt = db.prepare(`
      SELECT
        sp.id,
        sp.naam,
        sp.start_datum,
        sp.eind_datum,
        sp.deadline,
        sp.status,
        sp.pool_id,
        sp.definitief_op
      FROM dienstrooster_schedule_period sp
      JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
      WHERE sp.verwijderd_op IS NULL AND (? IS NULL OR pl.type = ?)
      ORDER BY sp.start_datum DESC
      LIMIT 100
    `);

    const rows = stmt.all(dienst, dienst) as Array<{
      id: string;
      naam: string;
      start_datum: string;
      eind_datum: string;
      deadline: string;
      status: string;
      pool_id: string;
      definitief_op: string | null;
    }>;

    // Each pool's active period (lib/activePeriod.ts) is marked on the list.
    const activeIds = new Set(getActivePeriods().map((p) => p.id));
    const response: ApiSuccessResponse<Array<PeriodSummary & { actief: boolean }>> = {
      success: true,
      data: rows.map((row) => ({ ...row, actief: activeIds.has(row.id) })),
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('periods-list', error);
  }
}
