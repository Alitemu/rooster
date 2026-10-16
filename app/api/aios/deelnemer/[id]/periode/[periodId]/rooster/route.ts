/**
 * GET /api/aios/deelnemer/[id]/periode/[periodId]/rooster - an AIOS's own
 * diensten of a published quarter, with their points and dienstpercentage
 * (G12: the AIOS sees it at the publication) and whether it is still
 * voorlopig. Before publication 404: the planner's roster in the making is
 * not theirs to see.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial } from '@/lib/auth-context';
import { aiosPeriodeBruikbaarVoor } from '@/lib/aiosToegang';
import { internalErrorResponse } from '@/lib/api-errors';
import { loadAiosPeriode } from '@/lib/aiosPreferences';
import { aiosEigenRooster } from '@/lib/aiosPublicatie';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string; periodId: string }> }): Promise<NextResponse> {
  const { id, periodId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;
    const period = loadAiosPeriode(periodId);
    if (!period || !aiosPeriodeBruikbaarVoor(auth!, id, period) || period.status !== 'GEPUBLICEERD') {
      return NextResponse.json({ success: false, error: { code: 'NOT_FOUND', message: 'Het rooster is nog niet gepubliceerd.' } }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: aiosEigenRooster(period, id) });
  } catch (error) {
    return internalErrorResponse('aios-eigen-rooster', error);
  }
}
