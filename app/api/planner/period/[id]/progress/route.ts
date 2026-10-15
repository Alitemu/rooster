/**
 * Period Progress Route
 *
 * GET /api/planner/period/[id]/progress - Per-person submission status
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { lastRemindedAt } from '@/lib/autoReminders';
import { loadPeriodProgress, type PeriodProgressRow } from '@/lib/periodProgress';
import type { ApiSuccessResponse } from '@/types';

interface PersonProgress extends PeriodProgressRow {
  // When they last got a reminder for this period, automatic or by hand.
  laatste_herinnering_op: string | null;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(_req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;

    // Every query below joins on the period, so an unknown id returned an
    // empty list with success:true - which on a stale link to a purged
    // period reads as "nobody is in this pool any more" rather than "this
    // period is gone". Same 404 the other planner views give.
    if (!db.prepare('SELECT 1 FROM dienstrooster_schedule_period WHERE id = ?').get(periodId)) {
      return NextResponse.json(
        { success: false, error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${periodId} niet gevonden` } },
        { status: 404 }
      );
    }

    const laatste = lastRemindedAt(periodId);
    const progress = loadPeriodProgress(periodId).map((p) => ({
      ...p,
      laatste_herinnering_op: laatste.get(p.person_id) ?? null,
    }));

    const response: ApiSuccessResponse<PersonProgress[]> = {
      success: true,
      data: progress,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('planner-progress', error);
  }
}
