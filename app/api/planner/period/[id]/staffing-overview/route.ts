/**
 * GET /api/planner/period/[id]/staffing-overview
 *
 * Everyone actually on duty this period - i.e. with at least one
 * assignment - with how many AVOND/WEEKEND/FEESTDAG shifts each of them
 * has. Distinct from AssignmentGrid/AssignmentCalendar (which list every
 * individual shift) and from the dashboard's large-imbalance list (which
 * is about ledger deltas, not raw counts) - this answers "who is
 * scheduled this period, and for how much of each shift type", which
 * neither of those already covers.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { TELLERS, type Teller } from '@/lib/rosterBands';

interface StaffingRow {
  person_id: string;
  codenaam: string;
  AVOND: number;
  WEEKEND: number;
  FEESTDAG: number;
  totaal: number;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;

    const period = db
      .prepare('SELECT id FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId);

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Periode niet gevonden' },
        { status: 404 }
      );
    }

    const rows = db
      .prepare(
        `SELECT p.id as person_id, p.codenaam, st.teller, COUNT(*) as count
         FROM dienstrooster_assignment a
         JOIN dienstrooster_person p ON p.id = a.person_id
         JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         WHERE a.schedule_version_id = ?
         GROUP BY p.id, st.teller`
      )
      .all(periodId) as Array<{ person_id: string; codenaam: string; teller: string; count: number }>;

    const byPerson = new Map<string, StaffingRow>();
    for (const row of rows) {
      let entry = byPerson.get(row.person_id);
      if (!entry) {
        entry = { person_id: row.person_id, codenaam: row.codenaam, AVOND: 0, WEEKEND: 0, FEESTDAG: 0, totaal: 0 };
        byPerson.set(row.person_id, entry);
      }
      if (TELLERS.includes(row.teller as Teller)) {
        entry[row.teller as Teller] = row.count;
      }
      entry.totaal += row.count;
    }

    const staff = Array.from(byPerson.values()).sort((a, b) => a.codenaam.localeCompare(b.codenaam));

    return NextResponse.json({
      success: true,
      data: {
        staff,
        totals: {
          AVOND: staff.reduce((sum, s) => sum + s.AVOND, 0),
          WEEKEND: staff.reduce((sum, s) => sum + s.WEEKEND, 0),
          FEESTDAG: staff.reduce((sum, s) => sum + s.FEESTDAG, 0),
          totaal: staff.reduce((sum, s) => sum + s.totaal, 0),
        },
      },
    });
  } catch (error) {
    return internalErrorResponse('staffing-overview', error);
  }
}
