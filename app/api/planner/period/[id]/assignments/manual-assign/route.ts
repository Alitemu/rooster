/**
 * POST /api/planner/period/[id]/assignments/manual-assign
 *
 * Manually assign a person to a slot.
 * Nothing here is a hard block, including an ABSOLUUT preference, a
 * part-time-free day, or the window rule - a manual fill is by definition
 * an exception the planner is making in consultation with the person
 * taking the shift, so this route must never stand in the way of that,
 * even a full week of consecutive shifts or a day the person explicitly
 * blocked, if that's genuinely what was agreed. Any of those is still
 * surfaced as a `warning` on the success response, and recorded on the
 * audit log entry, so the override is visible both at the moment it
 * happens and afterwards.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { dateToISO } from '@/lib/holidays';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { resolveRulesetConfig } from '@/lib/rosterBands';
import { personWouldViolateWindowRule } from '@/lib/windowRule';

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

    // Check blocking preferences and the window rule - neither is a hard
    // block here (see docstring above), just surfaced as a warning so the
    // planner knowingly overrides it. An ABSOLUUT block on this exact slot
    // outranks a window conflict derived from other slots, since it's the
    // more direct, more specific signal - matches the category priority in
    // lib/rosterGaps.ts.
    const blocked = db
      .prepare(
        `SELECT source FROM dienstrooster_availability
         WHERE person_id = ? AND slot_id = ? AND blocking_level = 'ABSOLUUT'`
      )
      .get(person_id, slot_id) as { source: string } | undefined;

    const config = resolveRulesetConfig(period);
    const windowWeeks = typeof config.windowWeeks === 'number' ? config.windowWeeks : 2;
    const windowConflict =
      !blocked &&
      personWouldViolateWindowRule(
        periodId,
        person_id as string,
        slot.iso_jaar,
        slot.iso_week,
        windowWeeks,
        slot_id as string
      );

    const warning = blocked
      ? blocked.source === 'PARTTIME'
        ? { code: 'PARTTIME_OVERRIDE', message: 'Let op: dit is een parttime-vrije dag voor deze persoon.' }
        : { code: 'BLOCKED_OVERRIDE', message: 'Let op: deze persoon heeft deze dag geblokkeerd.' }
      : windowConflict
        ? {
            code: 'WINDOW_OVERRIDE',
            message: `Let op: deze persoon heeft al een dienst binnen het venster van ${windowWeeks} weken.`,
          }
        : null;

    // If assignment already exists, return it
    if (existing && existing.person_id === person_id) {
      return NextResponse.json({
        success: true,
        data: {
          assignment: existing,
          message: 'Toewijzing bestaat al',
          warning,
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

    // Log audit entry - includes the override reason (if any) so a
    // deliberate overrule of a block/parttime-day/window-conflict is
    // visible in the audit trail, not just at the moment it happened.
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
      JSON.stringify({
        person_id,
        slot_id,
        reason: reason || null,
        override: warning ? { code: warning.code } : null,
      }),
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
        message: 'Toewijzing succesvol aangemaakt',
        warning,
      },
    });
  } catch (error) {
    return internalErrorResponse('manual-assign', error);
  }
}
