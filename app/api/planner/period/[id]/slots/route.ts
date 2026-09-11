/**
 * GET /api/planner/period/[id]/slots
 *
 * The full shift-slot grid for a period - every date/shift-type
 * combination that exists, whether or not it's assigned yet. Unlike
 * .../assignments (which only ever returns rows that already have an
 * assignment) this is what a calendar view needs to show empty days too,
 * so a planner can pre-fill a strong preference (e.g. a holiday) before
 * the solver has ever run - see generate-roster/route.ts's
 * manual_assignments handling for why the solver then respects it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface SlotRow {
  slot_id: string;
  datum: string;
  iso_jaar: number;
  iso_week: number;
  teller: string;
  is_feestdag: boolean;
  feestdag_naam: string | null;
  feestdag_groep: string | null;
  assignment: { id: string; person_id: string; codenaam: string; bron: string } | null;
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
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${periodId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const rows = db
      .prepare(
        `SELECT s.id as slot_id, s.datum, s.iso_jaar, s.iso_week, st.teller,
                s.is_feestdag, s.feestdag_naam, s.feestdag_groep,
                a.id as assignment_id, a.person_id, p.codenaam, a.bron
         FROM dienstrooster_shift_slot s
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         LEFT JOIN dienstrooster_assignment a ON a.slot_id = s.id AND a.schedule_version_id = ?
         LEFT JOIN dienstrooster_person p ON p.id = a.person_id
         WHERE s.period_id = ?
         ORDER BY s.datum, st.teller`
      )
      .all(periodId, periodId) as any[];

    const slots: SlotRow[] = rows.map((r) => ({
      slot_id: r.slot_id,
      datum: r.datum,
      iso_jaar: r.iso_jaar,
      iso_week: r.iso_week,
      teller: r.teller,
      is_feestdag: !!r.is_feestdag,
      feestdag_naam: r.feestdag_naam,
      feestdag_groep: r.feestdag_groep,
      assignment: r.assignment_id
        ? { id: r.assignment_id, person_id: r.person_id, codenaam: r.codenaam, bron: r.bron }
        : null,
    }));

    const response: ApiSuccessResponse<SlotRow[]> = { success: true, data: slots };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-slots', error);
  }
}
