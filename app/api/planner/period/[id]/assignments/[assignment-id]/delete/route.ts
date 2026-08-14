/**
 * DELETE /api/planner/period/[id]/assignments/[assignment-id]
 *
 * Remove an assignment (undo).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { dateToISO } from '@/lib/holidays';
import { getAuthContextFromRequest } from '@/lib/auth-context';

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; 'assignment-id': string } }
) {
  try {
    // Extract auth context (TODO: implement real auth)
    const auth = getAuthContextFromRequest(request);
    const actorId = auth?.userId || 'system';

    const periodId = params.id;
    const assignmentId = params['assignment-id'];
    const body = await request.json();
    const { reason } = body;
    const now = dateToISO(new Date());

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

    // Verify assignment exists and belongs to this period
    const assignment = db
      .prepare('SELECT * FROM dienstrooster_assignment WHERE id = ? AND schedule_version_id = ?')
      .get(assignmentId, periodId) as any;

    if (!assignment) {
      return NextResponse.json(
        { success: false, error: 'Assignment not found' },
        { status: 404 }
      );
    }

    // Only allow deletion of MANUAL or OVERRIDE assignments
    if (!['MANUAL', 'OVERRIDE'].includes(assignment.bron)) {
      return NextResponse.json(
        { success: false, error: `Cannot delete ${assignment.bron} assignments` },
        { status: 400 }
      );
    }

    // Log edit entry before deletion
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

    // Delete assignment
    db.prepare('DELETE FROM dienstrooster_assignment WHERE id = ?').run(assignmentId);

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
      'DELETE',
      JSON.stringify(assignment),
      null,
      now
    );

    return NextResponse.json({
      success: true,
      data: {
        assignment_id: assignmentId,
        message: 'Assignment deleted',
      },
    });
  } catch (error) {
    console.error('Assignment deletion error:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
