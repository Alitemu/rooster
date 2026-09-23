/**
 * Part-time Pattern Detail Routes
 *
 * PATCH  /api/person/[id]/parttime-patterns/[patternId] - Update pattern
 * DELETE /api/person/[id]/parttime-patterns/[patternId] - Delete pattern
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, personAccessDenial } from '@/lib/auth-context';
import { internalErrorResponse, isUniqueViolation, parseJsonBody } from '@/lib/api-errors';
import {
  syncAvailabilityForPattern,
  removePatternAvailability,
  getOpenPeriodsForPerson,
  findDeadlinePassedOverlappingPeriods,
  PARTTIME_WEEKDAGEN,
} from '@/lib/parttimeSync';
import { syncAbsencesForPerson } from '@/lib/absenceSync';
import { markSubmissionStarted } from '@/lib/submissionStatus';
import { writePreferencesBackup } from '@/lib/preferencesBackup';
import { buildDeadlinePassedWarning } from '@/lib/periodInputGate';
import { isValidIsoDate } from '@/lib/isoDate';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface UpdatePatternRequest {
  weekdag?: string;
  frequentie?: string;
  geldig_vanaf?: string;
  geldig_tot?: string;
}

/**
 * PATCH /api/person/[id]/parttime-patterns/[patternId] - Update pattern
 */
export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string; patternId: string }> }
): Promise<NextResponse> {
  const params = await props.params;
  try {
    const { id, patternId } = params;

    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;

    const body = (await parseJsonBody(req)) as UpdatePatternRequest;

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Persoon ${id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Verify pattern exists and belongs to person
    const patternStmt = db.prepare(`
      SELECT * FROM dienstrooster_parttime_pattern
      WHERE id = ? AND person_id = ?
    `);

    const pattern = patternStmt.get(patternId, id) as any;
    if (!pattern) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PATTERN_NOT_FOUND', message: `Patroon ${patternId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    if (body.weekdag && !PARTTIME_WEEKDAGEN.includes(body.weekdag as any)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_WEEKDAG',
          message: 'Een deeltijdpatroon geldt alleen voor doordeweekse dagen (maandag t/m vrijdag)',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Same checks as the create route - frequentie has a CHECK constraint
    // (an unknown value was a 500 instead of a 400), and a non-date passes
    // the string range check below and then silently matches no day.
    if (body.frequentie && !['ELKE_WEEK', 'EVEN_WEKEN', 'ONEVEN_WEKEN'].includes(body.frequentie)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_FREQUENTIE', message: 'Onbekende frequentie' },
      };
      return NextResponse.json(response, { status: 400 });
    }
    for (const value of [body.geldig_vanaf, body.geldig_tot]) {
      if (value && !isValidIsoDate(value)) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'INVALID_DATE', message: 'Gebruik een geldige datum (JJJJ-MM-DD)' },
        };
        return NextResponse.json(response, { status: 400 });
      }
    }

    // Update fields
    const updates: Record<string, any> = {};
    if (body.weekdag) updates.weekdag = body.weekdag;
    if (body.frequentie) updates.frequentie = body.frequentie;
    if (body.geldig_vanaf) updates.geldig_vanaf = body.geldig_vanaf;
    if (body.geldig_tot) updates.geldig_tot = body.geldig_tot;

    if (Object.keys(updates).length === 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'NO_UPDATES', message: 'Geen velden om bij te werken' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Same check the create route enforces - a reversed range is
    // otherwise silently accepted (it just matches zero days).
    const newVanaf = updates.geldig_vanaf ?? pattern.geldig_vanaf;
    const newTot = updates.geldig_tot ?? pattern.geldig_tot;
    if (newVanaf > newTot) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_RANGE', message: '"Vanaf" moet vóór of op "tot en met" liggen' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Build UPDATE statement dynamically
    const updateCols = Object.keys(updates).map((key) => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), patternId, id];

    const updateStmt = db.prepare(`
      UPDATE dienstrooster_parttime_pattern
      SET ${updateCols}
      WHERE id = ? AND person_id = ?
    `);

    const updateAndSync = db.transaction(() => {
      updateStmt.run(...values);
      const result = syncAvailabilityForPattern(patternId);
      // A shrunk or moved pattern can free a slot one of the person's
      // absences would cover - same reclaim the delete route does.
      syncAbsencesForPerson(id);
      return result;
    });

    const syncResult = updateAndSync();

    for (const periodId of getOpenPeriodsForPerson(id)) {
      markSubmissionStarted(id, periodId);
      try {
        writePreferencesBackup(id, periodId);
      } catch (backupError) {
        console.error('preferences-backup-write-failed', backupError);
      }
    }

    const warning = buildDeadlinePassedWarning(findDeadlinePassedOverlappingPeriods(id, newVanaf, newTot));

    const response: ApiSuccessResponse<{
      updated: boolean;
      availability_generated: number;
      warning?: string;
    }> = {
      success: true,
      data: { updated: true, availability_generated: syncResult.inserted, ...(warning ? { warning } : {}) },
    };

    return NextResponse.json(response);
  } catch (error) {
    // Moving a pattern onto a weekday the same person already has collides
    // with parttime_pattern_uniq - a conflict to explain, not a 500.
    if (isUniqueViolation(error)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PATTERN_ALREADY_EXISTS',
          message: 'Je hebt al een deeltijdpatroon voor deze dag in dezelfde periode',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }
    return internalErrorResponse('parttime-pattern-update', error);
  }
}

/**
 * DELETE /api/person/[id]/parttime-patterns/[patternId] - Delete pattern
 */
export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ id: string; patternId: string }> }
): Promise<NextResponse> {
  const params = await props.params;
  try {
    const { id, patternId } = params;

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

    // Ownership first, before touching any availability row - the release
    // below used to run before the (correctly person-scoped) DELETE found
    // nothing to delete, and the transaction still committed it: someone
    // else's pattern id was enough to strip that person's part-time blocks
    // out of every period still open for input. Same order the absence
    // DELETE route already uses.
    const owned = db
      .prepare(`SELECT id FROM dienstrooster_parttime_pattern WHERE id = ? AND person_id = ?`)
      .get(patternId, id);
    if (!owned) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PATTERN_NOT_FOUND', message: `Patroon ${patternId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Release generated availability rows first - bron_pattern_id has no
    // ON DELETE clause and foreign_keys=ON, so deleting the pattern first
    // would throw a constraint error.
    db.transaction(() => {
      removePatternAvailability(patternId);
      db.prepare(`DELETE FROM dienstrooster_parttime_pattern WHERE id = ? AND person_id = ?`).run(patternId, id);
      // A released slot may be one of the person's absences would cover
      // but was skipped for while this pattern held it - see
      // lib/absenceSync.ts's syncAbsencesForPerson.
      syncAbsencesForPerson(id);
    })();

    for (const periodId of getOpenPeriodsForPerson(id)) {
      markSubmissionStarted(id, periodId);
      try {
        writePreferencesBackup(id, periodId);
      } catch (backupError) {
        console.error('preferences-backup-write-failed', backupError);
      }
    }

    const response: ApiSuccessResponse<{ deleted: boolean }> = {
      success: true,
      data: { deleted: true },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('parttime-pattern-delete', error);
  }
}
