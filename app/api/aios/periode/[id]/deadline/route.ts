/**
 * PATCH /api/aios/periode/[id]/deadline { deadline, was } - move the AIOS's deadline (lib/aiosStatus.ts).
 * `was` is the deadline the planner saw: moved by someone else meanwhile, the answer is 409.
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
    const body = await parseJsonBody<{ deadline: unknown; was?: unknown }>(req);
    const result = zetAiosDeadline(period, body.deadline, auth!.userId, new Date(), body.was);
    if (!result.ok) return aiosFout(result.status, result.code, result.message);
    return NextResponse.json({ success: true, data: { gewijzigd: true } });
  } catch (error) {
    return internalErrorResponse('aios-deadline', error);
  }
}
