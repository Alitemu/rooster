/**
 * GET /api/planner/period/[id]/assignments/[assignment-id]/eligible-people
 *
 * Who could take over this assignment's slot instead - active pool members
 * minus whoever marked it ABSOLUUT and minus the person already on it.
 * Feeds the "wisselen" (swap) action in the assignments grid.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { getEligiblePeopleForSlot, type EligiblePerson } from '@/lib/rosterGaps';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; 'assignment-id': string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;
    const assignmentId = params['assignment-id'];

    const assignment = db
      .prepare(
        'SELECT slot_id, person_id FROM dienstrooster_assignment WHERE id = ? AND schedule_version_id = ?'
      )
      .get(assignmentId, periodId) as { slot_id: string; person_id: string } | undefined;

    if (!assignment) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const response: ApiSuccessResponse<EligiblePerson[]> = {
      success: true,
      data: getEligiblePeopleForSlot(periodId, assignment.slot_id, assignment.person_id),
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('assignment-eligible-people', error);
  }
}
