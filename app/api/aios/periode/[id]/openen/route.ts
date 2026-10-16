/**
 * POST /api/aios/periode/[id]/openen { deadline? } - open an AIOS period for
 * the AIOS's preferences (lib/aiosOpen.ts). The achterwacht's opening
 * (/api/periods/[id]/open) refuses an AIOS period.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { openAiosPeriod } from '@/lib/aiosOpen';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    const body = await parseJsonBody<{ deadline: unknown }>(req);
    // The audit row is written inside, with the status change.
    const result = openAiosPeriod(id, auth!.userId, body.deadline);
    if (!result.ok) return aiosFout(result.status, result.code, result.message);
    return NextResponse.json({ success: true, data: { status: 'OPEN', deadline: result.deadline } });
  } catch (error) {
    return internalErrorResponse('aios-openen', error);
  }
}
