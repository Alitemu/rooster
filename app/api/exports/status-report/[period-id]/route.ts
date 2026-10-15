/**
 * Status Report Export Route
 *
 * GET /api/exports/status-report/[period-id] - a workbook of per-person
 * submission status: the table "Status voorkeuren" on the period page, from
 * the same query (lib/periodProgress.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { xlsxDownload } from '@/lib/xlsxWrite';
import { loadPeriodProgress } from '@/lib/periodProgress';
import type { ApiErrorResponse } from '@/types';

export async function GET(req: NextRequest, props: { params: Promise<{ 'period-id': string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const otherDienst = periodDienstDenial(auth, params['period-id']);
    if (otherDienst) return otherDienst;

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

    const rows = loadPeriodProgress(periodId);

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
          { header: 'Deeltijd' },
          { header: 'Deeltijd gecontroleerd op' },
          { header: 'Fellow' },
        ],
        rows: rows.map((r) => {
          const status = r.submission_status ?? 'NIET_BEGONNEN';
          return [
            r.codenaam,
            statusLabels[status] || status,
            r.submitted_at ? { moment: r.submitted_at } : null,
            r.blocked_days_count,
            r.has_parttime_patterns ? 'Ja' : 'Nee',
            r.deeltijd_gecontroleerd_op ? { moment: r.deeltijd_gecontroleerd_op } : null,
            r.is_fellow ? 'Ja' : 'Nee',
          ];
        }),
      },
      'statusrapport',
      period.naam
    );
  } catch (error) {
    return internalErrorResponse('export-status-report', error);
  }
}
