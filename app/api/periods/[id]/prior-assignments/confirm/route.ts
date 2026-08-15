/**
 * PATCH /api/periods/[id]/prior-assignments/confirm - Confirm prior assignments
 *
 * Records that the planner has reviewed the overloop (carry-over) window
 * and confirms it's complete. Roster generation checks this is set before
 * proceeding, so a period can't be generated with unresolved prior-week
 * assignments.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { calculatePriorAssignmentWeeks } from '@/lib/priorAssignmentDerive';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;

    const period = db
      .prepare('SELECT id, pool_id, start_datum, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?')
      .get(id) as
      | { id: string; pool_id: string; start_datum: string; bevroren_ruleset_json: string | null }
      | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    let windowWeeks = 7;
    if (period.bevroren_ruleset_json) {
      try {
        windowWeeks = JSON.parse(period.bevroren_ruleset_json).windowWeeks || 7;
      } catch {
        // Fallback to default
      }
    }

    const hasPreviousPeriod = db
      .prepare(
        `SELECT id FROM dienstrooster_schedule_period
         WHERE pool_id = ? AND status = 'GEPUBLICEERD' AND eind_datum < ?
         LIMIT 1`
      )
      .get(period.pool_id, period.start_datum);

    const entryCount = (
      db
        .prepare('SELECT COUNT(*) as count FROM dienstrooster_prior_assignment WHERE period_id = ?')
        .get(id) as { count: number }
    ).count;

    // A pool's first-ever period has no previous period to carry over from.
    const expectedCount = hasPreviousPeriod ? calculatePriorAssignmentWeeks(windowWeeks) * 7 * 3 : 0;

    if (entryCount < expectedCount) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INCOMPLETE',
          message: `Prior assignments are incomplete: ${entryCount} of ${expectedCount} entries filled in`,
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const now = new Date().toISOString();
    db.prepare(
      'UPDATE dienstrooster_schedule_period SET overloop_bevestigd_op = ? WHERE id = ?'
    ).run(now, id);

    const response: ApiSuccessResponse<{ confirmed_op: string }> = {
      success: true,
      data: { confirmed_op: now },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('prior-assignments-confirm', error);
  }
}
