/**
 * Absence Management API Routes
 *
 * GET    /api/person/[id]/absences      - List absences
 * POST   /api/person/[id]/absences      - Create absence
 * PATCH  /api/person/[id]/absences/[id] - Update absence
 * DELETE /api/person/[id]/absences/[id] - Delete absence
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { syncAvailabilityForAbsence } from '@/lib/absenceSync';
import { getOpenPeriodsForPerson, findDeadlinePassedOverlappingPeriods } from '@/lib/parttimeSync';
import { markSubmissionStarted } from '@/lib/submissionStatus';
import { writePreferencesBackup } from '@/lib/preferencesBackup';
import { buildDeadlinePassedWarning } from '@/lib/periodInputGate';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface Absence {
  id: string;
  van_datum: string;
  tot_datum: string;
  soort: string;
  notitie?: string;
  blocked_days_in_period?: number;
  total_days_in_period?: number;
  // Every date within [van_datum, tot_datum] that has a shift slot in the
  // given period, and the subset of those actually confirmed blocked by
  // this absence - lets the UI draw a real day-by-day calendar instead of
  // just a count, so a participant can see, not just read, that it worked.
  slot_dates?: string[];
  blocked_dates?: string[];
}

interface CreateAbsenceRequest {
  van_datum: string; // ISO date
  tot_datum: string; // ISO date
  soort: string; // VAKANTIE, ZIEK, VERLOF, OVERIG
  notitie?: string;
}

/**
 * GET /api/person/[id]/absences - List all absences
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
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

    // A participant checking "did my absence actually register" needs to
    // SEE proof it really blocked shifts, not just read a count or an echo
    // of the dates they typed - optionally (when the caller knows which
    // period it's viewing) return, per absence, every date within its range
    // that has a shift slot in that period, and the subset of those genuinely
    // covered by an ABSENCE-sourced availability row this absence owns. The
    // two normally match exactly; a gap is real and informative (e.g. a day
    // the participant separately, deliberately blocked manually - see
    // absenceSync.ts's "never overwrite a MANUAL row" rule - not a sign of
    // failure) and lets the UI draw a day-by-day calendar instead of a
    // single trust-me count.
    const periodId = req.nextUrl.searchParams.get('period_id');

    const stmt = db.prepare(
      periodId
        ? `
      SELECT
        a.id, a.van_datum, a.tot_datum, a.soort, a.notitie,
        (SELECT GROUP_CONCAT(DISTINCT s.datum) FROM dienstrooster_shift_slot s
           WHERE s.period_id = ? AND s.datum >= a.van_datum AND s.datum <= a.tot_datum) as slot_dates_csv,
        (SELECT GROUP_CONCAT(DISTINCT s.datum) FROM dienstrooster_availability av
           JOIN dienstrooster_shift_slot s ON s.id = av.slot_id
           WHERE av.bron_absence_id = a.id AND s.period_id = ?) as blocked_dates_csv
      FROM dienstrooster_absence a
      WHERE a.person_id = ?
      ORDER BY a.van_datum DESC
    `
        : `
      SELECT id, van_datum, tot_datum, soort, notitie
      FROM dienstrooster_absence
      WHERE person_id = ?
      ORDER BY van_datum DESC
    `
    );

    const rows = (
      periodId ? stmt.all(periodId, periodId, id) : stmt.all(id)
    ) as Array<Absence & { slot_dates_csv?: string | null; blocked_dates_csv?: string | null }>;

    const absences: Absence[] = rows.map((row) => {
      const { slot_dates_csv, blocked_dates_csv, ...absence } = row;
      if (!periodId) return absence;
      const slot_dates = slot_dates_csv ? slot_dates_csv.split(',') : [];
      const blocked_dates = blocked_dates_csv ? blocked_dates_csv.split(',') : [];
      return {
        ...absence,
        slot_dates,
        blocked_dates,
        total_days_in_period: slot_dates.length,
        blocked_days_in_period: blocked_dates.length,
      };
    });

    const response: ApiSuccessResponse<Absence[]> = {
      success: true,
      data: absences,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('absences-list', error);
  }
}

/**
 * POST /api/person/[id]/absences - Create new absence
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
    }

    const body = (await parseJsonBody(req)) as CreateAbsenceRequest;

    const { van_datum, tot_datum, soort, notitie } = body;

    // Validate inputs
    if (!van_datum || !tot_datum || !soort) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Verplichte velden ontbreken: van_datum, tot_datum, soort',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const validSoorten = ['VAKANTIE', 'ZIEK', 'VERLOF', 'OVERIG'];
    if (!validSoorten.includes(soort)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_SOORT',
          message: `Onbekend soort: ${soort}`,
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (van_datum > tot_datum) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_RANGE', message: '"Van" moet vóór of op "tot" liggen' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    const person = personStmt.get(id) as any;
    if (!person) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Persoon ${id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Insert absence
    const insertStmt = db.prepare(`
      INSERT INTO dienstrooster_absence
      (id, person_id, van_datum, tot_datum, soort, notitie, aangemaakt_door, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const absenceId = crypto.randomUUID();
    insertStmt.run(
      absenceId,
      id,
      van_datum,
      tot_datum,
      soort,
      notitie || null,
      id, // Created by self
      new Date().toISOString()
    );

    syncAvailabilityForAbsence(absenceId);

    // Registering an absence generates ABSOLUUT rows exactly like a manual
    // calendar block does (see lib/absenceSync.ts), so it must be tracked
    // the same way: mark the submission as genuinely started (see
    // lib/submissionStatus.ts's doc comment - without this, someone who
    // only submits an absence stays "Niet begonnen" on the planner
    // dashboard, indistinguishable from someone who never opened the
    // link), and back up the resulting preference state.
    for (const periodId of getOpenPeriodsForPerson(id)) {
      markSubmissionStarted(id, periodId);
      try {
        writePreferencesBackup(id, periodId);
      } catch (backupError) {
        console.error('preferences-backup-write-failed', backupError);
      }
    }

    const createdAbsence: Absence = {
      id: absenceId,
      van_datum,
      tot_datum,
      soort,
      notitie,
    };

    const warning = buildDeadlinePassedWarning(
      findDeadlinePassedOverlappingPeriods(id, van_datum, tot_datum)
    );

    const response: ApiSuccessResponse<Absence & { warning?: string }> = {
      success: true,
      data: { ...createdAbsence, ...(warning ? { warning } : {}) },
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    return internalErrorResponse('absence-create', error);
  }
}
