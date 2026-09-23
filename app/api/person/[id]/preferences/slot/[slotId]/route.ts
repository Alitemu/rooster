/**
 * PATCH /api/person/[id]/preferences/slot/[slotId] - Update single preference
 *
 * Sets blocking level for a single slot (day + shift counter)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { isPeriodVisibleToPerson } from '@/lib/periodAccess';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { markSubmissionStarted } from '@/lib/submissionStatus';
import { writePreferencesBackup } from '@/lib/preferencesBackup';
import { checkPeriodAcceptsInput } from '@/lib/periodInputGate';
import { checkBlockBudget } from '@/lib/blockBudget';
import { syncPatternsForPerson } from '@/lib/parttimeSync';
import { syncAbsencesForPerson } from '@/lib/absenceSync';
import type { Teller } from '@/lib/rosterBands';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string; slotId: string }> }
): Promise<NextResponse> {
  const params = await props.params;
  try {
    const { id, slotId } = params;

    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;

    const body = (await parseJsonBody(req)) as {
      level: 'ABSOLUUT' | 'LIEVER_NIET' | 'VOORKEUR' | null;
    };
    const { level } = body; // ABSOLUUT, LIEVER_NIET, VOORKEUR, or null to clear

    // An explicit null clears; anything else must be one of the three
    // levels. A missing level used to fall through to the write below as
    // a NULL blocking_level with source MANUAL - which, via its ON CONFLICT
    // branch, silently took a slot over from an absence or part-time
    // pattern and unblocked it. An unknown string hit the CHECK constraint
    // and came back as a 500.
    if (level !== null && level !== 'ABSOLUUT' && level !== 'LIEVER_NIET' && level !== 'VOORKEUR') {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_LEVEL', message: 'Kies geblokkeerd, liever niet, voorkeur of leeg' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Persoon ${id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Verify slot exists and its period still accepts preference changes
    const slotStmt = db.prepare(
      `SELECT s.id, s.period_id, sp.status as period_status, sp.deadline as period_deadline,
              sp.bevroren_ruleset_json, sp.pool_id, sp.start_datum, sp.eind_datum, st.teller
       FROM dienstrooster_shift_slot s
       JOIN dienstrooster_schedule_period sp ON sp.id = s.period_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE s.id = ?`
    );
    const slot = slotStmt.get(slotId) as
      | {
          id: string;
          period_id: string;
          period_status: string;
          period_deadline: string;
          bevroren_ruleset_json: string | null;
          pool_id: string;
          start_datum: string;
          eind_datum: string;
          teller: Teller;
        }
      | undefined;
    // A slot belonging to a period this person has nothing to do with is
    // treated as not existing. This is a write path: without the check,
    // knowing any slot id from another pool was enough to put an
    // availability row into that pool's period - counting against its
    // block budget and feeding its solver run, for someone who is not in
    // it.
    if (
      !slot ||
      (!requirePlannerAccess(auth) &&
        !isPeriodVisibleToPerson(id, {
          id: slot.period_id,
          pool_id: slot.pool_id,
          start_datum: slot.start_datum,
          eind_datum: slot.eind_datum,
        }))
    ) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'SLOT_NOT_FOUND', message: `Dienst ${slotId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const gate = checkPeriodAcceptsInput({ status: slot.period_status, deadline: slot.period_deadline });
    if (!gate.allowed) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: gate.code!, message: gate.message! },
      };
      return NextResponse.json(response, { status: 403 });
    }

    // Only ABSOLUUT/LIEVER_NIET count against a block budget - VOORKEUR is a
    // positive preference, not a block, and clearing (level === null) only
    // ever frees up room.
    if (level === 'ABSOLUUT' || level === 'LIEVER_NIET') {
      const budgetCheck = checkBlockBudget({
        period: { bevroren_ruleset_json: slot.bevroren_ruleset_json, pool_id: slot.pool_id },
        periodId: slot.period_id,
        personId: id,
        teller: slot.teller,
        level,
        excludeSlotId: slotId,
      });
      if (!budgetCheck.allowed) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'BLOCK_BUDGET_EXCEEDED', message: budgetCheck.message! },
        };
        return NextResponse.json(response, { status: 400 });
      }
    }

    if (level === null) {
      // Delete preference (clear block)
      db.prepare(`DELETE FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?`).run(
        id,
        slotId
      );
      // The cleared slot might be one a part-time pattern or an absence
      // would otherwise cover but was skipped for when this manual block
      // got there first - see syncPatternsForPerson's doc comment.
      syncPatternsForPerson(id);
      syncAbsencesForPerson(id);
      markSubmissionStarted(id, slot.period_id);
    } else {
      // One statement instead of SELECT-then-INSERT-or-UPDATE.
      //
      // Not for a race: better-sqlite3 is synchronous and this deployment
      // runs a single Node process, so nothing can interleave between a
      // read and the write that follows it. It is for the second reason
      // below, and the single statement is simply the honest way to say
      // "this row should end up like this" - it also stays correct if this
      // ever runs with more than one worker.
      //
      // The UPDATE branch only ever set blocking_level, so a row a
      // part-time pattern or an absence had created kept its
      // source='PARTTIME'/'ABSENCE' and its bron_* id while now holding a
      // manually chosen level. That left the pattern believing it still
      // covered a slot whose ABSOLUUT had quietly become a VOORKEUR (so
      // the solver could roster that part-time free day), and the next
      // pattern edit deleted the person's own choice with it, because
      // reconcilePatternForPeriod removes rows by bron_pattern_id.
      // Setting it by hand means owning it: source becomes MANUAL and both
      // bron_* ids are cleared, which is exactly the "some other source
      // owns this slot" case both sync modules already document and skip
      // over.
      const writeAndMark = db.transaction(() => {
        db.prepare(
          `INSERT INTO dienstrooster_availability
             (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
           VALUES (?, ?, ?, ?, 'MANUAL', ?)
           ON CONFLICT(person_id, slot_id) DO UPDATE SET
             blocking_level = excluded.blocking_level,
             source = 'MANUAL',
             bron_pattern_id = NULL,
             bron_absence_id = NULL`
        ).run(crypto.randomUUID(), id, slotId, level, new Date().toISOString());

        // Together with the write: a crash in between would leave the
        // preference saved while the submission still reads as never
        // started, or the other way round.
        markSubmissionStarted(id, slot.period_id);
      });
      writeAndMark();
    }

    try {
      writePreferencesBackup(id, slot.period_id);
    } catch (backupError) {
      // Never let a filesystem backup problem fail the actual save.
      console.error('preferences-backup-write-failed', backupError);
    }

    const response: ApiSuccessResponse<{ updated: boolean }> = {
      success: true,
      data: { updated: true },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('preference-update', error);
  }
}
