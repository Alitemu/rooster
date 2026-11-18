/**
 * AIOS Diensten Route
 *
 * GET /api/planner/period/[id]/aios-diensten - An AIOS period's diensten
 * per day, with their blocks, and the points the quarter holds
 * (lib/aiosSlots.ts). What the planner sees before anything else exists.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { loadAiosDiensten, type AiosDienstenOverzicht } from '@/lib/aiosSlots';
import type { ApiSuccessResponse } from '@/types';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const otherDienst = periodDienstDenial(auth, params.id);
    if (otherDienst) return otherDienst;

    const period = db
      .prepare(
        `SELECT sp.start_datum, sp.eind_datum, pl.type AS pool_type FROM dienstrooster_schedule_period sp
         JOIN dienstrooster_pool pl ON pl.id = sp.pool_id WHERE sp.id = ?`
      )
      .get(params.id) as { start_datum: string; eind_datum: string; pool_type: string } | undefined;
    if (!period) {
      return NextResponse.json(
        { success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } },
        { status: 404 }
      );
    }
    if (period.pool_type !== 'AIOS') {
      return NextResponse.json(
        { success: false, error: { code: 'GEEN_AIOS_PERIODE', message: 'Dit overzicht is er alleen voor een periode van de AIOS' } },
        { status: 409 }
      );
    }

    const response: ApiSuccessResponse<AiosDienstenOverzicht> = {
      success: true,
      data: loadAiosDiensten(params.id, period.start_datum, period.eind_datum),
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('planner-aios-diensten', error);
  }
}
