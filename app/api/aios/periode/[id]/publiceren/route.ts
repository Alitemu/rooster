/**
 * POST /api/aios/periode/[id]/publiceren { bevestigd? } - the AIOS's roster
 * voorlopig published: every AIOS mailed their own diensten to check, and
 * they see them on their page (lib/aiosPublicatie.ts). From gegenereerd,
 * nothing being made. An empty dienst answers 409 NOT_READY, warnings 409
 * WARNINGS unless bevestigd, both with the check. The audit row is written
 * there, with the change.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { publiceerAiosRooster } from '@/lib/aiosPublicatie';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    const body = await parseJsonBody<{ bevestigd: unknown }>(req);
    const uitkomst = await publiceerAiosRooster(period, body.bevestigd === true, auth!.userId);
    if (!uitkomst.ok) {
      const { status, code, message, controle } = uitkomst;
      return NextResponse.json({ success: false, error: { code, message, ...(controle ? { controle } : {}) } }, { status });
    }
    return NextResponse.json({ success: true, data: { mail: uitkomst.mail } });
  } catch (error) {
    return internalErrorResponse('aios-publiceren', error);
  }
}
