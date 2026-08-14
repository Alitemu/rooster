/**
 * GET /api/planner/period/[id]/publication-check
 *
 * Validate that roster is ready for publication.
 * Checks: all slots filled, no hard blocking violations, band compliance.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = getAuthContextFromRequest(_request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;

    // Verify period exists
    const period = db
      .prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as any;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Period not found' },
        { status: 404 }
      );
    }

    const issues: string[] = [];
    let valid = true;

    // Check 1: All slots have assignments
    const slots = db
      .prepare('SELECT COUNT(*) as count FROM dienstrooster_shift_slot WHERE period_id = ?')
      .get(periodId) as any;
    const assignedSlots = db
      .prepare('SELECT COUNT(*) as count FROM dienstrooster_assignment WHERE schedule_version_id = ?')
      .get(periodId) as any;

    if (slots.count !== assignedSlots.count) {
      issues.push(`Only ${assignedSlots.count} of ${slots.count} slots are filled`);
      valid = false;
    }

    // Check 2: No hard blocking violations (ABSOLUUT)
    const blockingViolations = db
      .prepare(
        `SELECT COUNT(*) as count FROM dienstrooster_assignment a
         JOIN dienstrooster_availability av ON a.person_id = av.person_id AND a.slot_id = av.slot_id
         WHERE a.schedule_version_id = ? AND av.blocking_level = 'ABSOLUUT'`
      )
      .get(periodId) as any;

    if (blockingViolations.count > 0) {
      issues.push(`${blockingViolations.count} hard blocking violations (ABSOLUUT) found`);
      valid = false;
    }

    // Check 3: Get person count for band validation (sample check)
    const people = db
      .prepare(
        `SELECT DISTINCT person_id FROM dienstrooster_assignment
         WHERE schedule_version_id = ?`
      )
      .all(periodId) as any[];

    let bandViolations = 0;
    const band = [7, 8]; // Default band, could come from ruleset

    for (const p of people) {
      const assignmentCount = db
        .prepare(
          `SELECT COUNT(*) as count FROM dienstrooster_assignment
           WHERE schedule_version_id = ? AND person_id = ?`
        )
        .get(periodId, p.person_id) as any;

      if (assignmentCount.count < band[0] || assignmentCount.count > band[1]) {
        bandViolations++;
      }
    }

    if (bandViolations > 0) {
      issues.push(`${bandViolations} people have assignments outside their band range [${band[0]}, ${band[1]}]`);
      valid = false;
    }

    return NextResponse.json({
      success: true,
      data: {
        valid,
        issues,
        checks: {
          slots_filled: slots.count === assignedSlots.count,
          no_hard_blocking: blockingViolations.count === 0,
          band_compliance: bandViolations === 0,
        },
        totals: {
          total_slots: slots.count,
          assigned_slots: assignedSlots.count,
          people_affected: people.length,
        },
      },
    });
  } catch (error) {
    return internalErrorResponse('publication-check', error);
  }
}
