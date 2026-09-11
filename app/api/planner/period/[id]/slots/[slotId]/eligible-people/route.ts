/**
 * GET /api/planner/period/[id]/slots/[slotId]/eligible-people
 *
 * Same idea as assignments/[assignment-id]/eligible-people, but keyed
 * directly by slot rather than by an existing assignment - needed for a
 * slot that has nobody on it yet (the assignment-id route can't be
 * reached at all in that case, since there's no assignment id). Whoever
 * is currently on the slot, if anyone, is excluded from the list the same
 * way the assignment-id route excludes the current occupant. Feeds the
 * roster calendar's right-click assign/reassign menu.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { getEligiblePeopleForSlot, type EligiblePerson } from '@/lib/rosterGaps';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; slotId: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;
    const slotId = params.slotId;

    const slot = db
      .prepare('SELECT id FROM dienstrooster_shift_slot WHERE id = ? AND period_id = ?')
      .get(slotId, periodId);

    if (!slot) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'SLOT_NOT_FOUND', message: 'Dienst niet gevonden' },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const currentAssignment = db
      .prepare(
        'SELECT person_id FROM dienstrooster_assignment WHERE slot_id = ? AND schedule_version_id = ?'
      )
      .get(slotId, periodId) as { person_id: string } | undefined;

    const response: ApiSuccessResponse<EligiblePerson[]> = {
      success: true,
      data: getEligiblePeopleForSlot(periodId, slotId, currentAssignment?.person_id),
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('slot-eligible-people', error);
  }
}
