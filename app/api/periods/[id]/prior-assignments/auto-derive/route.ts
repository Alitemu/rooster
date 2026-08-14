/**
 * Prior Assignments Auto-Derive Route
 *
 * POST /api/periods/[id]/prior-assignments/auto-derive - Auto-derive from previous period
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import {
  calculatePriorAssignmentWeeks,
  calculatePriorAssignmentRange,
} from '@/lib/priorAssignmentDerive';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface AutoDeriveResult {
  period_id: string;
  derived_count: number;
  from_previous_period_id: string | null;
  message: string;
}

/**
 * POST /api/periods/[id]/prior-assignments/auto-derive - Auto-derive assignments
 *
 * Derives prior assignments from the previous period's published assignments.
 * Only processes the last windowWeeks-1 weeks of the prior period.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;

    // Fetch current period
    const periodStmt = db.prepare(`
      SELECT
        id,
        pool_id,
        start_datum,
        eind_datum,
        bevroren_ruleset_json
      FROM dienstrooster_schedule_period
      WHERE id = ?
    `);

    const period = periodStmt.get(id) as any;
    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Parse windowWeeks
    let windowWeeks = 7;
    if (period.bevroren_ruleset_json) {
      try {
        const config = JSON.parse(period.bevroren_ruleset_json);
        windowWeeks = config.windowWeeks || 7;
      } catch (e) {
        // Fallback
      }
    }

    // Find previous period (most recent before current)
    const prevStmt = db.prepare(`
      SELECT id, eind_datum
      FROM dienstrooster_schedule_period
      WHERE pool_id = ? AND status = 'GEPUBLICEERD' AND eind_datum < ?
      ORDER BY eind_datum DESC
      LIMIT 1
    `);

    const prevPeriod = prevStmt.get(period.pool_id, period.start_datum) as any;

    if (!prevPeriod) {
      const response: ApiSuccessResponse<AutoDeriveResult> = {
        success: true,
        data: {
          period_id: id,
          derived_count: 0,
          from_previous_period_id: null,
          message: 'No previous published period found',
        },
      };
      return NextResponse.json(response);
    }

    // Calculate lookback range from previous period
    const weeksToLookBack = calculatePriorAssignmentWeeks(windowWeeks);
    const [startDate, endDate] = calculatePriorAssignmentRange(
      prevPeriod.eind_datum,
      weeksToLookBack
    );

    // Fetch assignments from previous period in lookback range
    const assignmentsStmt = db.prepare(`
      SELECT
        a.slot_id,
        s.datum,
        s.iso_week,
        st.teller,
        a.person_id
      FROM dienstrooster_assignment a
      JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
      JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
      WHERE s.period_id = ? AND s.datum >= ? AND s.datum <= ?
      ORDER BY s.datum, st.teller
    `);

    const assignments = assignmentsStmt.all(
      prevPeriod.id,
      startDate,
      endDate
    ) as any[];

    // Create prior_assignment entries
    let derivedCount = 0;

    for (const assignment of assignments) {
      // Check if already exists
      const existingStmt = db.prepare(`
        SELECT id FROM dienstrooster_prior_assignment
        WHERE period_id = ? AND datum = ? AND teller = ?
      `);

      const existing = existingStmt.get(id, assignment.datum, assignment.teller);

      if (!existing) {
        // Insert new prior assignment
        const insertStmt = db.prepare(`
          INSERT INTO dienstrooster_prior_assignment
          (id, period_id, datum, iso_week, teller, person_id, bron, bron_period_id)
          VALUES (?, ?, ?, ?, ?, ?, 'AFGELEID', ?)
        `);

        insertStmt.run(
          crypto.randomUUID(),
          id,
          assignment.datum,
          assignment.iso_week,
          assignment.teller,
          assignment.person_id,
          prevPeriod.id
        );

        derivedCount++;
      }
    }

    const response: ApiSuccessResponse<AutoDeriveResult> = {
      success: true,
      data: {
        period_id: id,
        derived_count: derivedCount,
        from_previous_period_id: prevPeriod.id,
        message: `Derived ${derivedCount} assignments from previous period (${startDate} to ${endDate})`,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('prior-assignments-auto-derive', error);
  }
}
