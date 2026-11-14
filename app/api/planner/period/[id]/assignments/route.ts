/**
 * GET /api/planner/period/[id]/assignments
 *
 * List all assignments for a period with person details.
 * Supports filtering and pagination.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const otherDienst = periodDienstDenial(auth, params.id);
    if (otherDienst) return otherDienst;

    const periodId = params.id;
    const searchParams = request.nextUrl.searchParams;
    const personId = searchParams.get('person_id');
    const codenaam = searchParams.get('codenaam');
    const shiftType = searchParams.get('shift_type');

    // An invalid/missing value (?page=abc -> NaN, or omitted) must fall
    // back to a sane default rather than reach the SQL LIMIT/OFFSET
    // binding below as NaN, which better-sqlite3 rejects with a raw 500.
    // Upper-bounded at 5000 - well above any realistic page size, but
    // enough headroom for AssignmentCalendar's own one-shot
    // ?page_size=5000 fetch of a whole period at once - so a client can't
    // force an unbounded query by asking for an arbitrarily large page.
    const parsePositiveInt = (raw: string | null, fallback: number, max: number): number => {
      const n = raw === null ? NaN : parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1) return fallback;
      return Math.min(n, max);
    };
    const page = parsePositiveInt(searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER);
    const pageSize = parsePositiveInt(searchParams.get('page_size'), 50, 5000);

    // Verify period exists
    const period = db
      .prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as any;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Periode niet gevonden' },
        { status: 404 }
      );
    }

    // ?met_lege=1 (the list's tab Lijst once the roster is made, lib/rosterLijst.ts): every dienst of the
    // period, the empty ones as their own row (functional audit F-03, 1.7.0). The list showed only who was
    // ingedeeld, so 53 empty diensten were 53 missing rows: it ran from 29 January to 3 February without a
    // word. A search on a person has no empty row to show, so that stays a list of toewijzingen.
    const metLege = searchParams.get('met_lege') === '1' && !personId && !codenaam;

    // Build query
    let query = metLege
      ? `
      SELECT
        a.id,
        a.person_id,
        s.id AS slot_id,
        a.bron,
        a.aangemaakt_op,
        p.codenaam,
        s.datum,
        s.iso_week,
        s.shift_type_id,
        st.teller,
        s.benodigd_aantal_personen
      FROM dienstrooster_shift_slot s
      JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
      LEFT JOIN dienstrooster_assignment a ON a.slot_id = s.id AND a.schedule_version_id = ?
      LEFT JOIN dienstrooster_person p ON p.id = a.person_id
      WHERE s.period_id = ?
    `
      : `
      SELECT
        a.id,
        a.person_id,
        a.slot_id,
        a.bron,
        a.aangemaakt_op,
        p.codenaam,
        s.datum,
        s.iso_week,
        s.shift_type_id,
        st.teller,
        s.benodigd_aantal_personen
      FROM dienstrooster_assignment a
      JOIN dienstrooster_person p ON a.person_id = p.id
      JOIN dienstrooster_shift_slot s ON a.slot_id = s.id
      JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
      WHERE a.schedule_version_id = ?
    `;
    const params_list: any[] = metLege ? [periodId, periodId] : [periodId];

    if (personId) {
      query += ' AND a.person_id = ?';
      params_list.push(personId);
    }

    // Free-text filter used by the "Filter op codenaam" input - a
    // partial, case-insensitive match, since the planner types as they
    // go rather than picking from a known id.
    if (codenaam) {
      query += ' AND p.codenaam LIKE ?';
      params_list.push(`%${codenaam}%`);
    }

    if (shiftType) {
      query += ' AND st.teller = ?';
      params_list.push(shiftType);
    }

    // Add ordering
    query += ' ORDER BY s.datum ASC, p.codenaam ASC';

    // Get total count
    const countQuery = query.replace(
      /SELECT[\s\S]*?FROM/,
      'SELECT COUNT(*) as count FROM'
    );
    const countResult = db.prepare(countQuery).get(...params_list) as any;
    const total = countResult.count;

    // Add pagination
    const offset = (page - 1) * pageSize;
    query += ` LIMIT ? OFFSET ?`;
    params_list.push(pageSize, offset);

    // "Geruild" in the list instead of "Handmatig" (audit 1.2.2): an approved swap stores bron MANUAL,
    // like a planner's own change, and records itself as an assignment_edit of type RUIL. A shift whose
    // latest edit is that swap reads as geruild; a planner's change after it makes it Handmatig again.
    const laatsteBewerking = new Map(
      (
        db
          .prepare('SELECT toewijzing_id, edit_type FROM dienstrooster_assignment_edit WHERE periode_id = ? ORDER BY aangemaakt_op ASC, rowid ASC')
          .all(periodId) as Array<{ toewijzing_id: string; edit_type: string }>
      ).map((e) => [e.toewijzing_id, e.edit_type])
    );
    const assignments = (db.prepare(query).all(...params_list) as any[]).map((a) =>
      a.id === null
        ? { ...a, leeg: true, geruild: false }
        : { ...a, leeg: false, geruild: laatsteBewerking.get(a.id) === 'RUIL' }
    );

    return NextResponse.json({
      success: true,
      data: {
        assignments,
        pagination: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.ceil(total / pageSize),
        },
      },
    });
  } catch (error) {
    return internalErrorResponse('assignments-list', error);
  }
}
