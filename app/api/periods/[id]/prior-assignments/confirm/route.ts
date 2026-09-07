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
import { calculatePriorAssignmentWeeks, calculatePriorAssignmentRange } from '@/lib/priorAssignmentDerive';
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

    const prevPeriod = db
      .prepare(
        `SELECT id, eind_datum FROM dienstrooster_schedule_period
         WHERE pool_id = ? AND status = 'GEPUBLICEERD' AND eind_datum < ?
         ORDER BY eind_datum DESC
         LIMIT 1`
      )
      .get(period.pool_id, period.start_datum) as { id: string; eind_datum: string } | undefined;

    const entryCount = (
      db
        .prepare('SELECT COUNT(*) as count FROM dienstrooster_prior_assignment WHERE period_id = ?')
        .get(id) as { count: number }
    ).count;

    // A pool's first-ever period has no previous period to carry over from.
    //
    // "Complete" means every real shift in the lookback window is
    // accounted for - not 3 rows per calendar day. A flat weeksToLookBack
    // * 7 * 3 assumed AVOND, WEEKEND and FEESTDAG were all staffed on
    // every single day (WEEKEND only applies Sat/Sun, FEESTDAG only on an
    // actual holiday), so it could never be satisfied by auto-derive or
    // any realistic manual entry - the confirm gate was permanently
    // unreachable. The real expected count is exactly what auto-derive
    // itself finds: the assignments that actually existed in this window.
    let expectedCount = 0;
    if (prevPeriod) {
      const weeksToLookBack = calculatePriorAssignmentWeeks(windowWeeks);
      const [startDate, endDate] = calculatePriorAssignmentRange(prevPeriod.eind_datum, weeksToLookBack);
      expectedCount = (
        db
          .prepare(
            `SELECT COUNT(*) as count
             FROM dienstrooster_assignment a
             JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
             WHERE s.period_id = ? AND s.datum >= ? AND s.datum <= ?`
          )
          .get(prevPeriod.id, startDate, endDate) as { count: number }
      ).count;
    }

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
