/**
 * POST /api/planner/period/[id]/assignments/[assignment-id]/reassign
 *
 * Swap who is on a shift, in one step: delete-then-manually-assign was the
 * only way to do this before, which meant the shift sat fully unstaffed
 * (and disappeared from the assignments list) between the two calls, and a
 * failure partway through could leave it that way. Both steps happen in one
 * transaction here instead, and both are logged the same way a plain manual
 * delete or manual assign already are.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { dateToISO } from '@/lib/holidays';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; 'assignment-id': string } }
) {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const actorId = auth!.userId;

    const periodId = params.id;
    const assignmentId = params['assignment-id'];
    const body = await parseJsonBody(request);
    const { person_id: newPersonId, reason } = body;
    const now = dateToISO(new Date());

    if (!newPersonId) {
      return NextResponse.json(
        { success: false, error: 'Missing person_id' },
        { status: 400 }
      );
    }

    const period = db
      .prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as any;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Period not found' },
        { status: 404 }
      );
    }

    const assignment = db
      .prepare('SELECT * FROM dienstrooster_assignment WHERE id = ? AND schedule_version_id = ?')
      .get(assignmentId, periodId) as any;

    if (!assignment) {
      return NextResponse.json(
        { success: false, error: 'Assignment not found' },
        { status: 404 }
      );
    }

    // Same rule as plain delete: a published roster is what staff already
    // see, so an unexplained change to it isn't acceptable.
    if (period.status === 'GEPUBLICEERD' && !reason) {
      return NextResponse.json(
        { success: false, error: 'A reason is required when changing a published roster' },
        { status: 400 }
      );
    }

    if (newPersonId === assignment.person_id) {
      return NextResponse.json({
        success: true,
        data: { assignment, message: 'Toewijzing ongewijzigd' },
      });
    }

    const newPerson = db
      .prepare('SELECT id FROM dienstrooster_person WHERE id = ?')
      .get(newPersonId);

    if (!newPerson) {
      return NextResponse.json(
        { success: false, error: 'Person not found' },
        { status: 404 }
      );
    }

    const blocked = db
      .prepare(
        `SELECT 1 FROM dienstrooster_availability
         WHERE person_id = ? AND slot_id = ? AND blocking_level = 'ABSOLUUT'`
      )
      .get(newPersonId, assignment.slot_id);

    if (blocked) {
      return NextResponse.json(
        { success: false, error: 'Cannot assign: person has blocked this slot (ABSOLUUT)' },
        { status: 400 }
      );
    }

    const newAssignmentId = uuid();

    const run = db.transaction(() => {
      db.prepare(
        `INSERT INTO dienstrooster_assignment_edit
         (id, toewijzing_id, periode_id, person_id, slot_id, edit_type, reden, bewerkt_door_person_id, aangemaakt_op, row_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        assignmentId,
        periodId,
        assignment.person_id,
        assignment.slot_id,
        'HANDMATIG_VERWIJDEREN',
        reason || null,
        actorId,
        now,
        1
      );

      db.prepare('DELETE FROM dienstrooster_assignment WHERE id = ?').run(assignmentId);

      db.prepare(
        `INSERT INTO dienstrooster_assignment
         (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(newAssignmentId, periodId, newPersonId, assignment.slot_id, 'MANUAL', 1, now);

      db.prepare(
        `INSERT INTO dienstrooster_assignment_edit
         (id, toewijzing_id, periode_id, person_id, slot_id, edit_type, reden, bewerkt_door_person_id, aangemaakt_op, row_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        newAssignmentId,
        periodId,
        newPersonId,
        assignment.slot_id,
        'HANDMATIG_TOEWIJZEN',
        reason || null,
        actorId,
        now,
        1
      );

      db.prepare(
        `INSERT INTO dienstrooster_audit_log
         (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        actorId,
        'assignment',
        newAssignmentId,
        'UPDATE',
        JSON.stringify(assignment),
        JSON.stringify({ id: newAssignmentId, person_id: newPersonId, slot_id: assignment.slot_id }),
        now
      );
    });

    run();

    return NextResponse.json({
      success: true,
      data: {
        assignment_id: newAssignmentId,
        message: 'Toewijzing gewisseld',
      },
    });
  } catch (error) {
    return internalErrorResponse('assignment-reassign', error);
  }
}
