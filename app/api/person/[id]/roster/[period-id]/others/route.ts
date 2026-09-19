/**
 * GET /api/person/[id]/roster/[period-id]/others
 *
 * List OTHER people's assignments for a published period, so a staff
 * member can pick a shift to request in a swap. Excludes the requesting
 * person's own assignments (those come from /roster/[period-id] instead).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { isPeriodVisibleToPerson } from '@/lib/periodAccess';
import { internalErrorResponse } from '@/lib/api-errors';

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string; 'period-id': string }> }
) {
  const params = await props.params;
  try {
    const personId = params.id;
    const periodId = params['period-id'];

    const auth = getAuthContextFromRequest(request);
    const denied = personAccessDenial(auth, personId);
    if (denied) return denied;

    const period = db
      .prepare(
        `SELECT id, pool_id, status, start_datum, eind_datum
         FROM dienstrooster_schedule_period WHERE id = ?`
      )
      .get(periodId) as
      | { id: string; pool_id: string; status: string; start_datum: string; eind_datum: string }
      | undefined;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Periode niet gevonden' },
        { status: 404 }
      );
    }

    // This route hands out other people's codenamen and shift dates. Being
    // a participant somewhere was enough to read any published period that
    // way, including one belonging to a pool you have nothing to do with.
    // Staff pass by role (they may read every period); a participant has
    // to belong to this one.
    if (!requirePlannerAccess(auth) && !isPeriodVisibleToPerson(personId, period)) {
      return NextResponse.json(
        { success: false, error: 'Periode niet gevonden' },
        { status: 404 }
      );
    }

    if (period.status !== 'GEPUBLICEERD') {
      return NextResponse.json(
        { success: false, error: 'Rooster is nog niet gepubliceerd' },
        { status: 403 }
      );
    }

    const assignments = db
      .prepare(
        `SELECT
          a.id,
          a.person_id,
          p.codenaam,
          a.slot_id,
          s.datum,
          st.teller
         FROM dienstrooster_assignment a
         JOIN dienstrooster_shift_slot s ON a.slot_id = s.id
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         JOIN dienstrooster_person p ON p.id = a.person_id
         WHERE a.schedule_version_id = ? AND a.person_id != ?
         ORDER BY s.datum ASC`
      )
      .all(periodId, personId) as any[];

    return NextResponse.json({
      success: true,
      data: { assignments },
    });
  } catch (error) {
    return internalErrorResponse('roster-others', error);
  }
}
