/**
 * Prior Assignments API Routes
 *
 * GET  /api/periods/[id]/prior-assignments               - List prior assignments
 * PATCH /api/periods/[id]/prior-assignments              - Update assignments
 * POST /api/periods/[id]/prior-assignments/auto-derive   - Auto-derive from previous
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { findPreviousPublishedPeriod } from '@/lib/previousPeriod';
import {
  resolvePriorAssignmentWeeks,
  calculatePriorAssignmentRange, priorAssignmentAnchor,
} from '@/lib/priorAssignmentDerive';
import { getISOWeek, parseISO } from '@/lib/holidays';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { isValidIsoDate } from '@/lib/isoDate';
import { TELLERS } from '@/lib/rosterBands';
import { badRequest, optionalText } from '@/lib/requestFields';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface PriorAssignment {
  datum: string;
  iso_week: number;
  teller: string;
  person_codenaam: string | null;
  bron: string;
}

interface ListResponse {
  period_id: string;
  date_range: [string, string];
  total_entries: number;
  assignments: PriorAssignment[];
  status: 'partial' | 'complete';
}

/**
 * GET /api/periods/[id]/prior-assignments - List prior assignments
 *
 * Returns all prior assignments for this period's lookback window
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;

    // Fetch period
    const periodStmt = db.prepare(`
      SELECT pool_id, start_datum, eind_datum, bevroren_ruleset_json
      FROM dienstrooster_schedule_period
      WHERE id = ?
    `);

    const period = periodStmt.get(id) as any;
    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // The lookback window is relative to the previous published period's
    // end date, not this period's own - matches auto-derive's anchor.
    const prevPeriod = findPreviousPublishedPeriod(period.pool_id, period.start_datum);
    const lookbackAnchor = priorAssignmentAnchor(prevPeriod?.eind_datum, period.start_datum);


    // Fetch existing prior assignments
    const assignmentsStmt = db.prepare(`
      SELECT
        datum,
        iso_week,
        teller,
        person_id,
        bron
      FROM dienstrooster_prior_assignment
      WHERE period_id = ?
      ORDER BY datum, teller
    `);

    const rows = assignmentsStmt.all(id) as any[];

    // Fetch person names
    const personStmt = db.prepare(`
      SELECT id, codenaam FROM dienstrooster_person
    `);

    const persons = new Map(
      (personStmt.all() as any[]).map((p) => [p.id, p.codenaam])
    );

    // Map to response format
    const assignments = rows.map((r: any) => ({
      datum: r.datum,
      iso_week: r.iso_week,
      teller: r.teller,
      person_codenaam: r.person_id ? persons.get(r.person_id) || null : null,
      bron: r.bron,
    }));

    // Calculate date range
    const weeksToLookBack = resolvePriorAssignmentWeeks(period);
    const [startDate, endDate] = calculatePriorAssignmentRange(
      lookbackAnchor,
      weeksToLookBack
    );

    // Determine completeness - a pool's first-ever period has no previous
    // period to carry over from, so there's nothing to fill in.
    //
    // "Complete" means every real shift in the lookback window is
    // accounted for, not 3 rows per calendar day - WEEKEND only applies
    // Sat/Sun and FEESTDAG only on an actual holiday, so a flat
    // weeksToLookBack * 7 * 3 could never be reached in practice. Matches
    // the same real-count basis the confirm route now uses.
    const expectedCount = prevPeriod
      ? (
          db
            .prepare(
              `SELECT COUNT(*) as count
               FROM dienstrooster_assignment a
               JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
               WHERE s.period_id = ? AND s.datum >= ? AND s.datum <= ?`
            )
            .get(prevPeriod.id, startDate, endDate) as { count: number }
        ).count
      : 0;
    const status = assignments.length >= expectedCount ? 'complete' : 'partial';

    const response: ApiSuccessResponse<ListResponse> = {
      success: true,
      data: {
        period_id: id,
        date_range: [startDate, endDate],
        total_entries: assignments.length,
        assignments,
        status,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('prior-assignments-list', error);
  }
}

/**
 * PATCH /api/periods/[id]/prior-assignments - Update assignments
 *
 * Updates a single prior assignment with manual entry
 */
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const actorId = auth!.userId;

    const { id } = params;
    const body = await parseJsonBody(req) as any;

    const { datum, teller, person_codenaam } = body;

    if (!datum || !teller) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Verplichte velden ontbreken: datum, teller',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // The UPDATE below matches on `datum = ?`, so a value that merely looks
    // like a date just matches nothing there - harmless by itself. But the
    // INSERT it falls through to on no match feeds the same value into
    // getISOWeek(parseISO(datum)): a non-date produces NaN for both
    // iso_jaar/iso_week, which better-sqlite3 silently binds as NULL - and
    // those two columns are NOT NULL, so this used to surface as a raw 500
    // rather than the actual problem (a bad date). Whether or not it
    // crashed, iso_jaar/iso_week are exactly what the window rule and
    // holiday-spread checks use to place this row against the next
    // period's own slots (see lib/windowRule.ts) - a corrupted value here
    // wouldn't just fail loudly, it could poison next period's fairness
    // check for this person entirely.
    if (!isValidIsoDate(datum)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_DATE', message: 'Datum moet in het formaat JJJJ-MM-DD staan' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // The CHECK on teller refused anything else inside the INSERT, a 500.
    if (!TELLERS.includes(teller)) {
      return badRequest('INVALID_TELLER', 'Kies avonddienst, weekenddienst of feestdagdienst');
    }
    const codenaam = optionalText(person_codenaam);
    if (!codenaam.ok) {
      return badRequest('INVALID_INPUT', 'Codenaam moet tekst zijn');
    }

    const period = db.prepare('SELECT start_datum FROM dienstrooster_schedule_period WHERE id = ?').get(id) as
      | { start_datum: string }
      | undefined;
    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' },
      };
      return NextResponse.json(response, { status: 404 });
    }
    // Shifts before the period only, as the CSV import keeps them: a row on
    // a day of the period became a fixed shift for the solver and the
    // window checks that nobody holds in the roster (audit 14).
    if (datum >= period.start_datum) {
      return badRequest('NOT_BEFORE_PERIOD', 'Een eerdere toewijzing ligt vóór de start van de periode');
    }

    // Look up person ID if person_codenaam provided
    let personId: string | null = null;
    if (person_codenaam) {
      const personStmt = db.prepare(
        `SELECT id FROM dienstrooster_person WHERE codenaam = ?`
      );
      const person = personStmt.get(person_codenaam) as any;
      personId = person?.id || null;

      if (!personId) {
        const response: ApiErrorResponse = {
          success: false,
          error: {
            code: 'PERSON_NOT_FOUND',
            message: `Persoon met codenaam ${person_codenaam} niet gevonden`,
          },
        };
        return NextResponse.json(response, { status: 404 });
      }
    }

    // Update or insert prior assignment
    const updateStmt = db.prepare(`
      UPDATE dienstrooster_prior_assignment
      SET person_id = ?, bron = 'HANDMATIG'
      WHERE period_id = ? AND datum = ? AND teller = ?
    `);

    const before = db
      .prepare('SELECT person_id FROM dienstrooster_prior_assignment WHERE period_id = ? AND datum = ? AND teller = ?')
      .get(id, datum, teller) as { person_id: string | null } | undefined;
    const result = updateStmt.run(personId, id, datum, teller);

    if (result.changes === 0) {
      // Insert if not exists
      const insertStmt = db.prepare(`
        INSERT INTO dienstrooster_prior_assignment
        (id, period_id, datum, iso_jaar, iso_week, teller, person_id, bron, bron_period_id, aangemaakt_door, aangemaakt_op)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'HANDMATIG', NULL, ?, ?)
      `);

      const [year, week] = getISOWeek(parseISO(datum));

      insertStmt.run(
        crypto.randomUUID(),
        id,
        datum,
        year,
        week,
        teller,
        personId,
        actorId,
        new Date().toISOString()
      );
    }

    // "Rooster vooraf" is what the solver takes as already decided (audit 9).
    writeAuditLog({
      actorId,
      entiteit: 'schedule_period',
      entiteitId: id,
      actie: 'UPDATE',
      oud: before ? { datum, teller, person_id: before.person_id } : undefined,
      nieuw: { wijziging: 'rooster vooraf aangepast', datum, teller, person_id: personId },
    });

    const response: ApiSuccessResponse<{ updated: boolean }> = {
      success: true,
      data: { updated: true },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('prior-assignments-update', error);
  }
}
