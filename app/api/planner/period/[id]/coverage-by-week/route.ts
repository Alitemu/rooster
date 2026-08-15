/**
 * GET /api/planner/period/[id]/coverage-by-week
 *
 * Per ISO week in the period: how many pool members are still coverable
 * (not ABSOLUUT-blocked on every slot in the week), and a red/orange/green
 * status (red <=7, orange 8-10, green >=11).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { computeCoverageByWeek, getPoolSizeForPeriod } from '@/lib/weekCoverage';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;

    const period = db
      .prepare('SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { pool_id: string } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${periodId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const weeks = computeCoverageByWeek(periodId, period.pool_id);

    const response: ApiSuccessResponse<{ period_id: string; pool_size: number; weeks: typeof weeks }> = {
      success: true,
      data: {
        period_id: periodId,
        pool_size: getPoolSizeForPeriod(periodId),
        weeks,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('coverage-by-week', error);
  }
}
