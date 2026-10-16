/**
 * PATCH /api/aios/periode/[id]/deadline { deadline } - move the AIOS's deadline (lib/aiosStatus.ts).
 * The audit row is written there, with the change.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { zetAiosDeadline } from '@/lib/aiosStatus';

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    const result = zetAiosDeadline(period, (await parseJsonBody<{ deadline: unknown }>(req)).deadline, auth!.userId);
    if (!result.ok) return aiosFout(result.status, result.code, result.message);
    return NextResponse.json({ success: true, data: { gewijzigd: true } });
  } catch (error) {
    return internalErrorResponse('aios-deadline', error);
  }
}
