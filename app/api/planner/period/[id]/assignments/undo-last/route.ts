/**
 * POST /api/planner/period/[id]/assignments/undo-last
 *
 * Reverses the single most recent manual assign/reassign/remove recorded
 * for this period by lib/pendingUndo.ts - see that module's docstring for
 * why this reads from its own table rather than the audit log.
 *
 * Every branch below re-checks that the slot is still in exactly the state
 * the original action left it in before touching anything - that's what
 * makes this safe to call from a stale page (a different tab, a planner
 * who stepped away and came back, or another planner entirely): if the
 * slot has moved on since (regenerated, reassigned again, filled by
 * someone else), undo is refused with a clear reason instead of silently
 * overwriting whatever is there now.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { getPendingUndo, clearPendingUndo } from '@/lib/pendingUndo';
import type { ApiErrorResponse, ApiSuccessResponse } from '@/types';

interface UndoRequest {
  reason?: string;
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const actorId = auth!.userId;
    const periodId = params.id;
    const body = await parseJsonBody<UndoRequest>(request);
    const reason = body.reason?.trim() || null;
    const now = new Date().toISOString();

    const pending = getPendingUndo(periodId);
    if (!pending || pending.scope !== 'PERIOD_ASSIGNMENT') {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'NOTHING_TO_UNDO', message: 'Er is niets meer om ongedaan te maken' },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const period = db
      .prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { status: string } | undefined;
    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${periodId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Same disclosure rule as manual-assign/reassign/delete themselves - an
    // unexplained change to a published roster isn't acceptable, and
    // undoing one is still a change to it.
    if (period.status === 'GEPUBLICEERD' && !reason) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'REASON_REQUIRED', message: 'Een reden is verplicht bij het wijzigen van een gepubliceerd rooster' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const payload = JSON.parse(pending.payload_json) as Record<string, string>;
    const staleResponse: ApiErrorResponse = {
      success: false,
      error: {
        code: 'UNDO_STALE',
        message: 'Deze wijziging kan niet meer ongedaan gemaakt worden - er is intussen iets anders met deze dienst gebeurd.',
      },
    };

    const applied = db.transaction((): boolean => {
      if (pending.action_type === 'ASSIGN') {
        const current = db
          .prepare('SELECT id, person_id FROM dienstrooster_assignment WHERE id = ? AND schedule_version_id = ?')
          .get(payload.assignment_id, periodId) as { id: string; person_id: string } | undefined;
        if (!current || current.person_id !== payload.person_id) return false;

        db.prepare('DELETE FROM dienstrooster_assignment WHERE id = ?').run(payload.assignment_id);
        db.prepare(
          `INSERT INTO dienstrooster_assignment_edit
             (id, toewijzing_id, periode_id, person_id, slot_id, edit_type, reden, bewerkt_door_person_id, aangemaakt_op, row_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(uuid(), payload.assignment_id, periodId, payload.person_id, payload.slot_id, 'HANDMATIG_VERWIJDEREN', reason, actorId, now, 1);
        db.prepare(
          `INSERT INTO dienstrooster_audit_log
             (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(uuid(), actorId, 'assignment', payload.assignment_id, 'DELETE', JSON.stringify(current), null, now);
        return true;
      }

      if (pending.action_type === 'REASSIGN') {
        const current = db
          .prepare('SELECT id, person_id, slot_id, row_version FROM dienstrooster_assignment WHERE id = ? AND schedule_version_id = ?')
          .get(payload.assignment_id, periodId) as
          | { id: string; person_id: string; slot_id: string; row_version: number }
          | undefined;
        if (!current || current.person_id !== payload.current_person_id) return false;

        db.prepare('UPDATE dienstrooster_assignment SET person_id = ?, row_version = row_version + 1 WHERE id = ?').run(
          payload.previous_person_id,
          payload.assignment_id
        );
        db.prepare(
          `INSERT INTO dienstrooster_assignment_edit
             (id, toewijzing_id, periode_id, person_id, slot_id, edit_type, reden, bewerkt_door_person_id, aangemaakt_op, row_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(uuid(), payload.assignment_id, periodId, payload.previous_person_id, payload.slot_id, 'HANDMATIG_TOEWIJZEN', reason, actorId, now, 1);
        db.prepare(
          `INSERT INTO dienstrooster_audit_log
             (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          uuid(),
          actorId,
          'assignment',
          payload.assignment_id,
          'UPDATE',
          JSON.stringify(current),
          JSON.stringify({ id: payload.assignment_id, person_id: payload.previous_person_id, slot_id: payload.slot_id }),
          now
        );
        return true;
      }

      // REMOVE
      const stillEmpty = db
        .prepare('SELECT 1 FROM dienstrooster_assignment WHERE schedule_version_id = ? AND slot_id = ?')
        .get(periodId, payload.slot_id);
      if (stillEmpty) return false;

      const newAssignmentId = uuid();
      db.prepare(
        `INSERT INTO dienstrooster_assignment
           (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(newAssignmentId, periodId, payload.person_id, payload.slot_id, payload.bron, 1, now);
      db.prepare(
        `INSERT INTO dienstrooster_assignment_edit
           (id, toewijzing_id, periode_id, person_id, slot_id, edit_type, reden, bewerkt_door_person_id, aangemaakt_op, row_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(uuid(), newAssignmentId, periodId, payload.person_id, payload.slot_id, 'HANDMATIG_TOEWIJZEN', reason, actorId, now, 1);
      db.prepare(
        `INSERT INTO dienstrooster_audit_log
           (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        actorId,
        'assignment',
        newAssignmentId,
        'CREATE',
        null,
        JSON.stringify({ id: newAssignmentId, person_id: payload.person_id, slot_id: payload.slot_id }),
        now
      );
      return true;
    })();

    if (!applied) {
      clearPendingUndo(periodId);
      return NextResponse.json(staleResponse, { status: 409 });
    }

    clearPendingUndo(periodId);

    const response: ApiSuccessResponse<{ undone: true; label: string }> = {
      success: true,
      data: { undone: true, label: pending.label },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('assignments-undo-last', error);
  }
}
