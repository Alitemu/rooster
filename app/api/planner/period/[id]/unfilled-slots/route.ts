/**
 * GET /api/planner/period/[id]/unfilled-slots
 *
 * Lists shift slots still short of their required headcount, along with
 * which pool members are eligible to fill each one.
 *
 * The solver's capacity/band constraints are soft (see solver/constraints.py),
 * so a generated roster can come back with gaps when there simply aren't
 * enough people for the window/band settings. This is what feeds the
 * planner's "fill the rest by hand, in consultation with the person on
 * duty" workflow.
 *
 * The query itself lives in lib/rosterGaps so it can be tested against a
 * real database without a running server.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { findUnfilledSlots, type UnfilledSlot } from '@/lib/rosterGaps';
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

    const { id: periodId } = params;

    const period = db
      .prepare('SELECT id FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId);

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${periodId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const response: ApiSuccessResponse<UnfilledSlot[]> = {
      success: true,
      data: findUnfilledSlots(periodId),
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('unfilled-slots', error);
  }
}
