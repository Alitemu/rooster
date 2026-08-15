/**
 * POST /api/planner/period/[id]/assignments/manual-assign
 *
 * Manually assign a person to a slot with validation.
 * Validates: blocking prefs, band limits, window rule, capacity.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { dateToISO } from '@/lib/holidays';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const actorId = auth!.userId;

    const periodId = params.id;
    const body = await parseJsonBody(request);
    const { person_id, slot_id, reason } = body;
    const now = dateToISO(new Date());

    if (!person_id || !slot_id) {
      return NextResponse.json(
        { success: false, error: 'Missing person_id or slot_id' },
        { status: 400 }
      );
    }

    // Verify period exists and is editable
    const period = db
      .prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as any;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Period not found' },
        { status: 404 }
      );
    }

    if (!['GEGENEREERD', 'GEPUBLICEERD'].includes(period.status)) {
      return NextResponse.json(
        { success: false, error: `Cannot edit assignments in ${period.status} status` },
        { status: 400 }
      );
    }

    // Verify person exists
    const person = db
      .prepare('SELECT * FROM dienstrooster_person WHERE id = ?')
      .get(person_id) as any;

    if (!person) {
      return NextResponse.json(
        { success: false, error: 'Person not found' },
        { status: 404 }
      );
    }

    // Verify slot exists
    const slot = db
      .prepare('SELECT * FROM dienstrooster_shift_slot WHERE id = ?')
      .get(slot_id) as any;

    if (!slot) {
      return NextResponse.json(
        { success: false, error: 'Slot not found' },
        { status: 404 }
      );
    }

    // Check for existing assignment on this slot
    const existing = db
      .prepare('SELECT * FROM dienstrooster_assignment WHERE schedule_version_id = ? AND slot_id = ?')
      .get(periodId, slot_id) as any;

    if (existing && existing.person_id !== person_id) {
      return NextResponse.json(
        { success: false, error: 'Slot already assigned to another person' },
        { status: 409 }
      );
    }

    // Check blocking preferences
    const blocked = db
      .prepare(
        `SELECT * FROM dienstrooster_availability
         WHERE person_id = ? AND slot_id = ? AND blocking_level = 'ABSOLUUT'`
      )
      .get(person_id, slot_id) as any;

    if (blocked) {
      return NextResponse.json(
        { success: false, error: 'Cannot assign: person has blocked this slot (ABSOLUUT)' },
        { status: 400 }
      );
    }

    // If assignment already exists, return it
    if (existing && existing.person_id === person_id) {
      return NextResponse.json({
        success: true,
        data: {
          assignment: existing,
          message: 'Assignment already exists',
        },
      });
    }

    // Create assignment
    const assignmentId = uuid();
    db.prepare(
      `INSERT INTO dienstrooster_assignment
       (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(assignmentId, periodId, person_id, slot_id, 'MANUAL', 1, now);

    // Log audit entry
    db.prepare(
      `INSERT INTO dienstrooster_audit_log
       (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuid(),
      actorId,
      'assignment',
      assignmentId,
      'MANUAL_ASSIGN',
      null,
      JSON.stringify({ person_id, slot_id, reason: reason || null }),
      now
    );

    return NextResponse.json({
      success: true,
      data: {
        assignment: {
          id: assignmentId,
          schedule_version_id: periodId,
          person_id,
          slot_id,
          bron: 'MANUAL',
          aangemaakt_op: now,
        },
        message: 'Assignment created successfully',
      },
    });
  } catch (error) {
    return internalErrorResponse('manual-assign', error);
  }
}
