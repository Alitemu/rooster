/**
 * POST /api/planner/period/[id]/assignments/[assignment-id]/reassign
 *
 * Swap who is on a shift, in one step: delete-then-manually-assign was the
 * only way to do this before, which meant the shift sat fully unstaffed
 * (and disappeared from the assignments list) between the two calls, and a
 * failure partway through could leave it that way. Both steps happen in one
 * transaction here instead, and both are logged the same way a plain manual
 * delete or manual assign already are.
 *
 * An ABSOLUUT block, a part-time-free day, or a window-rule conflict on
 * the new person is not a hard stop - same reasoning as manual-assign -
 * just a `warning` on the success response and a note on the audit log
 * entry.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { dateToISO } from '@/lib/holidays';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { resolveRulesetConfig } from '@/lib/rosterBands';
import { personWouldViolateWindowRule } from '@/lib/windowRule';
import { queueBlockOverriddenNotification } from '@/lib/notifications';

const OVERRIDE_REDEN_FALLBACK: Record<string, string> = {
  BLOCKED_OVERRIDE: 'een geblokkeerde dag is toch ingepland',
  PARTTIME_OVERRIDE: 'een parttime-vrije dag is toch ingepland',
  WINDOW_OVERRIDE: 'een dienst binnen het venster is toch ingepland',
};

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
        { success: false, error: 'person_id ontbreekt' },
        { status: 400 }
      );
    }

    const period = db
      .prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as any;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Periode niet gevonden' },
        { status: 404 }
      );
    }

    // Same whitelist as manual-assign - a reassign is only meaningful
    // once a roster actually exists (GEGENEREERD/GEPUBLICEERD). Without
    // this, an assignment left over after a ruleset edit demotes the
    // period back to OPEN (see ruleset/route.ts) could still be
    // reassigned while the period nominally sits in an input-collection
    // status the UI presents as "not yet rostered".
    if (!['GEGENEREERD', 'GEPUBLICEERD'].includes(period.status)) {
      return NextResponse.json(
        { success: false, error: `Toewijzingen aanpassen kan niet in status ${period.status}` },
        { status: 400 }
      );
    }

    const assignment = db
      .prepare('SELECT * FROM dienstrooster_assignment WHERE id = ? AND schedule_version_id = ?')
      .get(assignmentId, periodId) as any;

    if (!assignment) {
      return NextResponse.json(
        { success: false, error: 'Toewijzing niet gevonden' },
        { status: 404 }
      );
    }

    // Same rule as plain delete: a published roster is what staff already
    // see, so an unexplained change to it isn't acceptable.
    if (period.status === 'GEPUBLICEERD' && !reason) {
      return NextResponse.json(
        { success: false, error: 'Een reden is verplicht bij het wijzigen van een gepubliceerd rooster' },
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
      .prepare('SELECT id, codenaam FROM dienstrooster_person WHERE id = ?')
      .get(newPersonId) as { id: string; codenaam: string } | undefined;

    if (!newPerson) {
      return NextResponse.json(
        { success: false, error: 'Persoon niet gevonden' },
        { status: 404 }
      );
    }

    // Not a hard block - a swap is a deliberate planner exception, made in
    // consultation with the person taking the shift, so this must never
    // stand in the way of it, even a day the person explicitly blocked.
    // Surfaced as a warning instead, so the planner knowingly overrides it.
    const blocked = db
      .prepare(
        `SELECT source FROM dienstrooster_availability
         WHERE person_id = ? AND slot_id = ? AND blocking_level = 'ABSOLUUT'`
      )
      .get(newPersonId, assignment.slot_id) as { source: string } | undefined;

    // An ABSOLUUT block on this exact slot outranks a window conflict
    // derived from other slots - matches the category priority in
    // lib/rosterGaps.ts.
    const slot = db
      .prepare('SELECT datum, iso_jaar, iso_week FROM dienstrooster_shift_slot WHERE id = ?')
      .get(assignment.slot_id) as { datum: string; iso_jaar: number; iso_week: number };
    const config = resolveRulesetConfig(period);
    const windowWeeks = typeof config.windowWeeks === 'number' ? config.windowWeeks : 2;
    const windowConflict =
      !blocked &&
      personWouldViolateWindowRule(
        periodId,
        newPersonId as string,
        slot.iso_jaar,
        slot.iso_week,
        windowWeeks,
        assignment.slot_id
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
        JSON.stringify({
          id: newAssignmentId,
          person_id: newPersonId,
          slot_id: assignment.slot_id,
          override: warning ? { code: warning.code } : null,
        }),
        now
      );
    });

    run();

    // Prepared for when there's a way to reach the participant outside the
    // app - see lib/notifications.ts. A no-op today (NOTIFICATIONS_ENABLED
    // is off by default), never allowed to affect whether the swap itself
    // succeeded.
    if (warning) {
      queueBlockOverriddenNotification({
        personId: newPersonId as string,
        codenaam: newPerson.codenaam,
        periodId,
        periodeNaam: period.naam,
        details: `Dienst op ${slot.datum}`,
        reden: (reason as string | undefined) || OVERRIDE_REDEN_FALLBACK[warning.code],
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        assignment_id: newAssignmentId,
        message: 'Toewijzing gewisseld',
        warning,
      },
    });
  } catch (error) {
    return internalErrorResponse('assignment-reassign', error);
  }
}
