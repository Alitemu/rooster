/**
 * POST /api/planner/period/[id]/import-holidays - Bulk-import holiday rotation history
 *
 * Body: { rows: [{ codenaam, holiday_group, year }] }
 * holiday_history isn't period-scoped (it's a person's history across
 * years), so the period id here is only used for auth/route consistency
 * with the rest of the setup wizard's import steps.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse } from '@/types';

interface HolidayRow {
  codenaam: string;
  holiday_group: string;
  year: number;
}

const VALID_GROUPS = new Set([
  'NIEUWJAAR', 'PASEN', 'KONINGSDAG', 'BEVRIJDINGSDAG', 'HEMELVAART', 'PINKSTEREN', 'KERST',
]);

export async function POST(
  req: NextRequest,
  { params: _params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const body = (await req.json()) as { rows?: HolidayRow[] };
    const rows = body.rows || [];

    const errors: string[] = [];
    let imported = 0;

    const upsert = db.prepare(
      `INSERT INTO dienstrooster_holiday_history (id, person_id, feestdag_groep, jaar, bron)
       VALUES (?, ?, ?, ?, 'IMPORT')
       ON CONFLICT(person_id, feestdag_groep, jaar) DO UPDATE SET bron = 'IMPORT'`
    );

    const importAll = db.transaction((importRows: HolidayRow[]) => {
      for (const row of importRows) {
        if (!VALID_GROUPS.has(row.holiday_group)) {
          errors.push(`Unknown holiday group: ${row.holiday_group}`);
          continue;
        }

        const person = db
          .prepare('SELECT id FROM dienstrooster_person WHERE codenaam = ?')
          .get(row.codenaam) as { id: string } | undefined;

        if (!person) {
          errors.push(`Unknown codenaam: ${row.codenaam}`);
          continue;
        }

        upsert.run(crypto.randomUUID(), person.id, row.holiday_group, row.year);
        imported++;
      }
    });

    importAll(rows);

    const response: ApiSuccessResponse<{ imported: number; errors: string[] }> = {
      success: true,
      data: { imported, errors },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('import-holidays', error);
  }
}
