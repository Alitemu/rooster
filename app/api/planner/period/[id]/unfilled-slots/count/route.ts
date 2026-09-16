/**
 * GET /api/planner/period/[id]/unfilled-slots/count
 *
 * Just the number of slots still short of their required headcount - see
 * lib/rosterGaps.ts's countUnfilledSlots for why this is a separate,
 * cheap endpoint rather than reusing ../unfilled-slots and reading
 * `.length`: that one also computes each slot's eligible_people (pool
 * members + preferences + a window-conflict batch query), which a
 * freshly opened period pays for on every one of its slots just to
 * render a "N diensten nog niet ingevuld" summary nobody asked to expand
 * yet.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { countUnfilledSlots } from '@/lib/rosterGaps';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id: periodId } = params;

    const period = db
      .prepare('SELECT id FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId);

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${periodId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const response: ApiSuccessResponse<{ count: number }> = {
      success: true,
      data: { count: countUnfilledSlots(periodId) },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('unfilled-slots-count', error);
  }
}
