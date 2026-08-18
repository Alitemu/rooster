/**
 * Status Report Export Route
 *
 * GET /api/exports/status-report/[period-id] - Generate CSV of per-person
 * submission status, matching what the Planner Dashboard's Staff Status
 * table shows.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiErrorResponse } from '@/types';

export async function GET(
  req: NextRequest,
  { params }: { params: { 'period-id': string } }
): Promise<NextResponse> {
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
            THEN 'Yes' ELSE 'No'
          END as has_parttime_patterns
        FROM dienstrooster_person p
        LEFT JOIN dienstrooster_submission s ON p.id = s.person_id AND s.schedule_period_id = ?
        WHERE p.id IN (
          SELECT DISTINCT person_id
          FROM dienstrooster_pool_membership
          WHERE pool_id = (SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?)
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

    const csvLines: string[] = [
      'Name,Status,Submitted At,Blocked Days,Has Part-time Patterns',
      ...rows.map(
        (r) =>
          `"${r.codenaam}","${r.status}","${r.submitted_at || ''}",${r.blocked_days_count},"${r.has_parttime_patterns}"`
      ),
    ];

    const csvContent = csvLines.join('\n');

    return new NextResponse(csvContent, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="status_report_${period.naam.replace(/ /g, '_')}.csv"`,
      },
    });
  } catch (error) {
    return internalErrorResponse('export-status-report', error);
  }
}
