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
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { TELLERS, computeMemberTargets, type Teller } from '@/lib/rosterBands';
import { getFellowIds } from '@/lib/fellows';
import { isAiosPeriod } from '@/lib/aiosPeriod';
import { streefbereikRij, uitkomstPerSoort, type StreefbereikRij } from '@/lib/streefbereikPerPersoon';

interface StaffingRow {
  person_id: string;
  codenaam: string;
  AVOND: number;
  WEEKEND: number;
  FEESTDAG: number;
  totaal: number;
  fellow: boolean;
  // 2.2.0: what this person should get, saldo included. 2.3.0: per kind whether the count fits it ("goed",
  // "1 te veel", "2 tekort"), only once the roster has diensten in it: before that everyone is "short".
  streefbereik: StreefbereikRij | null;
  uitkomst: Record<Teller, string> | null;
  // The range as numbers, for the dashed box over each bar (2.3.0). A fellow's weekend has none.
  bereik: Record<Teller, { min: number; max: number } | null> | null;
}

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const otherDienst = periodDienstDenial(auth, params.id);
    if (otherDienst) return otherDienst;

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

    const fellows = getFellowIds(periodId);
    const byPerson = new Map<string, StaffingRow>();
    for (const row of rows) {
      let entry = byPerson.get(row.person_id);
      if (!entry) {
        entry = {
          person_id: row.person_id,
          codenaam: row.codenaam,
          AVOND: 0,
          WEEKEND: 0,
          FEESTDAG: 0,
          totaal: 0,
          fellow: fellows.has(row.person_id),
          streefbereik: null,
          uitkomst: null,
          bereik: null,
        };
        byPerson.set(row.person_id, entry);
      }
      if (TELLERS.includes(row.teller as Teller)) {
        entry[row.teller as Teller] = row.count;
      }
      entry.totaal += row.count;
    }

    // Everyone with a streefbereik, also who got no dienst at all: that is the person a planner looks for
    // (2.2.0). The list showed only who was on duty.
    const targets = isAiosPeriod(periodId) ? new Map() : computeMemberTargets(periodId);
    const heeftRooster = rows.length > 0;
    const naam = db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?');
    for (const [personId, target] of targets) {
      let entry = byPerson.get(personId);
      if (!entry) {
        const p = naam.get(personId) as { codenaam: string } | undefined;
        if (!p) continue;
        entry = { person_id: personId, codenaam: p.codenaam, AVOND: 0, WEEKEND: 0, FEESTDAG: 0, totaal: 0, fellow: fellows.has(personId), streefbereik: null, uitkomst: null, bereik: null };
        byPerson.set(personId, entry);
      }
      entry.streefbereik = streefbereikRij(target);
      entry.bereik = Object.fromEntries(
        TELLERS.map((t) => [t, target[t].fellow ? null : { min: target[t].min, max: target[t].max }])
      ) as Record<Teller, { min: number; max: number } | null>;
      entry.uitkomst = heeftRooster ? uitkomstPerSoort(target, entry) : null;
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
