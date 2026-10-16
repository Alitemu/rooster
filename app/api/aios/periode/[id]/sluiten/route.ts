/**
 * POST /api/aios/periode/[id]/sluiten - close an AIOS period for preferences (lib/aiosStatus.ts).
 * The audit row is written there, with the change.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { sluitAiosPeriode } from '@/lib/aiosStatus';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    const result = sluitAiosPeriode(period, auth!.userId);
    if (!result.ok) return aiosFout(result.status, result.code, result.message);
    return NextResponse.json({ success: true, data: { gewijzigd: true } });
  } catch (error) {
    return internalErrorResponse('aios-sluiten', error);
  }
}
