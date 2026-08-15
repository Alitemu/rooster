/**
 * Period Capacity Check API Route
 *
 * GET  /api/periods/[id]/capacity  - Check capacity constraints
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { checkCapacity, getCapacityInterpretation } from '@/lib/capacity';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface CapacityCheckResult {
  period_id: string;
  valid: boolean;
  total_capacity: {
    satisfied: boolean;
    pool_capacity: number;
    required_slots: number;
  };
  distinct_people: {
    satisfied: boolean;
    required_people: number;
    active_participants: number;
  };
  message: string;
  is_constraining: 'distinct_people' | 'total_capacity' | 'both' | 'none';
}

/**
 * GET /api/periods/[id]/capacity - Check period capacity
 *
 * Returns both capacity constraints (total and distinct people)
 * and which is more restrictive
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;

    // Fetch period details
    const periodStmt = db.prepare(`
      SELECT
        id,
        start_datum,
        eind_datum,
        status
      FROM dienstrooster_schedule_period
      WHERE id = ?
    `);

    const period = periodStmt.get(id) as any;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PERIOD_NOT_FOUND',
          message: `Period ${id} not found`,
        },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Fetch frozen ruleset to get windowWeeks
    const rulesetStmt = db.prepare(`
      SELECT bevroren_ruleset_json
      FROM dienstrooster_schedule_period
      WHERE id = ?
    `);

    const rulesetRow = rulesetStmt.get(id) as any;
    let windowWeeks = 7; // default

    if (rulesetRow?.bevroren_ruleset_json) {
      try {
        const config = JSON.parse(rulesetRow.bevroren_ruleset_json);
        windowWeeks = config.windowWeeks || 7;
      } catch (e) {
        // Fallback to default if JSON parse fails
      }
    }

    // Count active pool members
    const membersStmt = db.prepare(`
      SELECT COUNT(DISTINCT pm.person_id) as count
      FROM dienstrooster_pool_membership pm
      JOIN dienstrooster_schedule_period sp ON sp.pool_id = pm.pool_id
      WHERE sp.id = ?
        AND pm.geldig_vanaf <= sp.eind_datum
        AND pm.geldig_tot >= sp.start_datum
    `);

    const membersRow = membersStmt.get(id) as any;
    const activeParticipants = membersRow?.count || 0;

    const startDate = new Date(period.start_datum);
    const endDate = new Date(period.eind_datum);
    const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const weeks = days / 7;

    // Prefer the actual generated slot count (accurate, reflects holidays
    // etc.); fall back to the 7-slots-per-week heuristic before slots exist
    // (e.g. while still setting up dates in the wizard).
    const slotCountRow = db
      .prepare('SELECT COUNT(*) as count FROM dienstrooster_shift_slot WHERE period_id = ?')
      .get(id) as { count: number } | undefined;
    const requiredSlots = slotCountRow?.count ? slotCountRow.count : Math.round(weeks) * 7;

    // Run capacity check
    const result = checkCapacity(
      weeks,
      windowWeeks,
      activeParticipants,
      requiredSlots
    );

    // Determine which constraint is more restrictive
    let isConstraining: 'distinct_people' | 'total_capacity' | 'both' | 'none' = 'none';
    if (!result.distinctPeople.passed && !result.totalCapacity.passed) {
      isConstraining = 'both';
    } else if (!result.distinctPeople.passed) {
      isConstraining = 'distinct_people';
    } else if (!result.totalCapacity.passed) {
      isConstraining = 'total_capacity';
    }

    const response: ApiSuccessResponse<CapacityCheckResult> = {
      success: true,
      data: {
        period_id: id,
        valid: result.overallPassed,
        total_capacity: {
          satisfied: result.totalCapacity.passed,
          pool_capacity: result.totalCapacity.poolCapacity,
          required_slots: requiredSlots,
        },
        distinct_people: {
          satisfied: result.distinctPeople.passed,
          required_people: result.distinctPeople.required,
          active_participants: activeParticipants,
        },
        message: getCapacityInterpretation(windowWeeks, requiredSlots, activeParticipants),
        is_constraining: isConstraining,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-capacity', error);
  }
}
