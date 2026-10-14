/**
 * Status Report Export Route
 *
 * GET /api/exports/status-report/[period-id] - a workbook of per-person
 * submission status, matching what the Planner Dashboard's Staff Status
 * table shows.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { xlsxDownload } from '@/lib/xlsxWrite';
import type { ApiErrorResponse } from '@/types';

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
        `SELECT
          p.codenaam,
          COALESCE(s.status, 'NIET_BEGONNEN') as status,
          s.ingediend_op as submitted_at,
          (SELECT COUNT(*) FROM dienstrooster_availability
           WHERE person_id = p.id
           AND slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)
           AND blocking_level = 'ABSOLUUT') as blocked_days_count,
          CASE
            WHEN (SELECT COUNT(*) FROM dienstrooster_parttime_pattern WHERE person_id = p.id) > 0
            THEN 'Ja' ELSE 'Nee'
          END as has_parttime_patterns
        FROM dienstrooster_person p
        LEFT JOIN dienstrooster_submission s ON p.id = s.person_id AND s.schedule_period_id = ?
        WHERE p.id IN (
          SELECT DISTINCT pm.person_id
          FROM dienstrooster_pool_membership pm
          JOIN dienstrooster_schedule_period sp2 ON sp2.id = ?
          JOIN dienstrooster_person p2 ON p2.id = pm.person_id
          WHERE pm.pool_id = sp2.pool_id
            AND pm.geldig_vanaf <= sp2.eind_datum AND pm.geldig_tot >= sp2.start_datum
            AND p2.actief = 1
        )
        ORDER BY p.codenaam ASC`
      )
      .all(periodId, periodId, periodId) as Array<{
        codenaam: string;
        status: string;
        submitted_at: string | null;
        blocked_days_count: number;
        has_parttime_patterns: string;
      }>;

    const statusLabels: Record<string, string> = {
      NIET_BEGONNEN: 'Niet begonnen',
      BEZIG: 'Bezig',
      BEVESTIGD: 'Bevestigd',
    };

    return xlsxDownload(
      {
        name: 'Status',
        columns: [
          { header: 'Codenaam' },
          { header: 'Status' },
          { header: 'Ingediend op' },
          { header: 'Geblokkeerde dagen' },
          { header: 'Heeft deeltijdpatroon' },
        ],
        rows: rows.map((r) => [
          r.codenaam,
          statusLabels[r.status] || r.status,
          r.submitted_at ? { moment: r.submitted_at } : null,
          r.blocked_days_count,
          r.has_parttime_patterns,
        ]),
      },
      'statusrapport',
      period.naam
    );
  } catch (error) {
    return internalErrorResponse('export-status-report', error);
  }
}
