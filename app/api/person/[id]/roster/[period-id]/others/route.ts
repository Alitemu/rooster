/**
 * GET /api/person/[id]/roster/[period-id]/others
 *
 * List OTHER people's assignments for a published period, so a staff
 * member can pick a shift to request in a swap. Excludes the requesting
 * person's own assignments (those come from /roster/[period-id] instead).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; 'period-id': string } }
) {
  try {
    const personId = params.id;
    const periodId = params['period-id'];

    const auth = getAuthContextFromRequest(request);
    if (!requirePersonAccess(auth, personId)) {
      return forbiddenResponse();
    }

    const period = db
      .prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { status: string } | undefined;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Period not found' },
        { status: 404 }
      );
    }

    if (period.status !== 'GEPUBLICEERD') {
      return NextResponse.json(
        { success: false, error: 'Roster not yet published' },
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
