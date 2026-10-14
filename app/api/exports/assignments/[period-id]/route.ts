/**
 * Assignments (Roster) Export Route
 *
 * GET /api/exports/assignments/[period-id] - a workbook of every assignment in
 * this period (datum, week, diensttype, codenaam) - a backup of "who
 * worked when" a planner can keep for a period, and later re-upload on a
 * FUTURE period's "Eerdere toewijzingen" screen if that future period's
 * own overloop can't be auto-derived (e.g. this period's own data is no
 * longer in this deployment - see that screen's upload,
 * app/planner/period/[id]/prior-assignments/page.tsx, and
 * import-csv/route.ts, which is built to read exactly this shape back).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { xlsxDownload } from '@/lib/xlsxWrite';
import type { ApiErrorResponse } from '@/types';

const TELLER_LABELS: Record<string, string> = {
  AVOND: 'Avond',
  WEEKEND: 'Weekend',
  FEESTDAG: 'Feestdag',
};

export async function GET(req: NextRequest, props: { params: Promise<{ 'period-id': string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params['period-id'];

    const period = db
      .prepare('SELECT naam FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { naam: string } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Periode niet gevonden' },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const rows = db
      .prepare(
        `SELECT s.datum, s.iso_week, st.teller, p.codenaam
         FROM dienstrooster_assignment a
         JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         JOIN dienstrooster_person p ON p.id = a.person_id
         WHERE a.schedule_version_id = ?
         ORDER BY s.datum, st.teller`
      )
      .all(periodId) as Array<{ datum: string; iso_week: number; teller: string; codenaam: string }>;

    return xlsxDownload(
      {
        name: 'Rooster',
        columns: [{ header: 'Datum' }, { header: 'Week' }, { header: 'Diensttype' }, { header: 'Codenaam' }],
        rows: rows.map((r) => [{ date: r.datum }, r.iso_week, TELLER_LABELS[r.teller] || r.teller, r.codenaam]),
      },
      'rooster',
      period.naam
    );
  } catch (error) {
    return internalErrorResponse('export-assignments', error);
  }
}
