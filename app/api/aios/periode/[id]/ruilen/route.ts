/**
 * GET /api/aios/periode/[id]/ruilen - every swap request of an AIOS
 * period, for the planner: who asked whom, what for what, how it stands
 * (lib/aiosRuilen.ts). The AIOS swap without the planner (L1, L2).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosRuilenVoorPlanner } from '@/lib/aiosRuilen';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    return NextResponse.json({ success: true, data: aiosRuilenVoorPlanner(period) });
  } catch (error) {
    return internalErrorResponse('aios-ruilen-planner', error);
  }
}
