/**
 * Absence Detail Routes
 *
 * PATCH  /api/person/[id]/absences/[absenceId] - Update absence
 * DELETE /api/person/[id]/absences/[absenceId] - Delete absence
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, personAccessDenial } from '@/lib/auth-context';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { syncAvailabilityForAbsence, removeAbsenceAvailability } from '@/lib/absenceSync';
import { getOpenPeriodsForPerson, findDeadlinePassedOverlappingPeriods, syncPatternsForPerson } from '@/lib/parttimeSync';
import { markSubmissionStarted } from '@/lib/submissionStatus';
import { writePreferencesBackup } from '@/lib/preferencesBackup';
import { buildDeadlinePassedWarning } from '@/lib/periodInputGate';
import { isValidIsoDate } from '@/lib/isoDate';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface UpdateAbsenceRequest {
  van_datum?: string;
  tot_datum?: string;
  soort?: string;
  notitie?: string;
}

/**
 * PATCH /api/person/[id]/absences/[absenceId] - Update absence
 */
export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string; absenceId: string }> }
): Promise<NextResponse> {
  const params = await props.params;
  try {
    const { id, absenceId } = params;

    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;

    const body = (await parseJsonBody(req)) as UpdateAbsenceRequest;

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Persoon ${id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Verify absence exists and belongs to person
    const absenceStmt = db.prepare(`
      SELECT * FROM dienstrooster_absence
      WHERE id = ? AND person_id = ?
    `);

    const absence = absenceStmt.get(absenceId, id) as any;
    if (!absence) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'ABSENCE_NOT_FOUND', message: `Afwezigheid ${absenceId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    if (body.soort) {
      const validSoorten = ['VAKANTIE', 'CONGRES', 'OVERIG'];
      if (!validSoorten.includes(body.soort)) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'INVALID_SOORT', message: `Onbekend soort: ${body.soort}` },
        };
        return NextResponse.json(response, { status: 400 });
      }
    }

    // Update fields
    const updates: Record<string, any> = {};
    if (body.van_datum) updates.van_datum = body.van_datum;
    if (body.tot_datum) updates.tot_datum = body.tot_datum;
    if (body.soort) updates.soort = body.soort;
    if (body.notitie !== undefined) updates.notitie = body.notitie || null;

    if (Object.keys(updates).length === 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'NO_UPDATES', message: 'Geen velden om bij te werken' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Same reason as the create route: the range check below compares two
    // strings alphabetically, which says nothing useful about a value that
    // is not a date at all.
    for (const value of [updates.van_datum, updates.tot_datum]) {
      if (value !== undefined && !isValidIsoDate(value)) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'INVALID_DATE', message: 'Gebruik een geldige datum (JJJJ-MM-DD)' },
        };
        return NextResponse.json(response, { status: 400 });
      }
    }

    const newVanDatum = updates.van_datum ?? absence.van_datum;
    const newTotDatum = updates.tot_datum ?? absence.tot_datum;
    if (newVanDatum > newTotDatum) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_RANGE', message: '"Van" moet vóór of op "tot" liggen' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Build UPDATE statement dynamically
    const updateCols = Object.keys(updates).map((key) => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), absenceId, id];

    const updateStmt = db.prepare(`
      UPDATE dienstrooster_absence
      SET ${updateCols}
      WHERE id = ? AND person_id = ?
    `);

    // The edit and both re-syncs are one change: a crash between them
    // leaves the absence saying one thing and the blocked days another.
    // The backup below stays outside - it writes to disk, and a slow
    // filesystem must never hold the database's write lock.
    const applyEdit = db.transaction(() => {
      updateStmt.run(...values);

      syncAvailabilityForAbsence(absenceId);

      // A shrunk or moved date range can free up a slot the person's own
      // part-time pattern would otherwise cover - see syncPatternsForPerson's
      // doc comment for why that reclaim doesn't happen automatically.
      syncPatternsForPerson(id);
    });
    applyEdit();

    // Same as the create route: an edit still changes what's blocked, so
    // it must be tracked as a genuinely-started submission and backed up.
    for (const periodId of getOpenPeriodsForPerson(id)) {
      markSubmissionStarted(id, periodId);
      try {
        writePreferencesBackup(id, periodId);
      } catch (backupError) {
        console.error('preferences-backup-write-failed', backupError);
      }
    }

    const warning = buildDeadlinePassedWarning(
      findDeadlinePassedOverlappingPeriods(id, newVanDatum, newTotDatum)
    );

    const response: ApiSuccessResponse<{ updated: boolean; warning?: string }> = {
      success: true,
      data: { updated: true, ...(warning ? { warning } : {}) },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('absence-update', error);
  }
}

/**
 * DELETE /api/person/[id]/absences/[absenceId] - Delete absence
 */
export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ id: string; absenceId: string }> }
): Promise<NextResponse> {
  const params = await props.params;
  try {
    const { id, absenceId } = params;

    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Persoon ${id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Verify absence exists and belongs to person - must check ownership
    // before touching its availability rows below, otherwise a crafted
    // absenceId belonging to someone else would have its blocking rows
    // wiped even though the final DELETE (correctly scoped to this person)
    // would then no-op.
    const absence = db
      .prepare(`SELECT id FROM dienstrooster_absence WHERE id = ? AND person_id = ?`)
      .get(absenceId, id);
    if (!absence) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'ABSENCE_NOT_FOUND', message: `Afwezigheid ${absenceId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // All three together. Removing the availability rows has to happen
    // before the absence row itself (bron_absence_id has no ON DELETE
    // clause and foreign_keys=ON would reject the delete), but as separate
    // statements a crash in between left the absence still on the books
    // with nothing blocked for it any more - an afwezigheid that silently
    // stopped protecting its own dates, visible nowhere.
    //
    // better-sqlite3 nests transactions as savepoints, so the ones inside
    // these two helpers simply join this one.
    const deleteAbsence = db.transaction(() => {
      removeAbsenceAvailability(absenceId);
      db.prepare(`DELETE FROM dienstrooster_absence WHERE id = ? AND person_id = ?`).run(absenceId, id);
      // Same reclaim as the PATCH route - a deleted absence can free up a
      // slot the person's own part-time pattern would otherwise cover.
      syncPatternsForPerson(id);
    });
    deleteAbsence();

    const response: ApiSuccessResponse<{ deleted: boolean }> = {
      success: true,
      data: { deleted: true },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('absence-delete', error);
  }
}
