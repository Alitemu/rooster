/**
 * POST /api/aios/periode/[id]/ruilen/[ruilId]/herinneren { bevestigd: true }
 * - the planner reminds the colleague of an open request
 * (lib/aiosRuilen.ts herinnerAiosRuil). Without `bevestigd` nothing is sent
 * and the answer says when the last reminder went (BEVESTIGING).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { herinnerAiosRuil } from '@/lib/aiosRuilen';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string; ruilId: string }> }): Promise<NextResponse> {
  const { id, ruilId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    const body = await parseJsonBody<{ bevestigd?: unknown }>(req);
    const uitkomst = herinnerAiosRuil(period, ruilId, 'PLANNER', auth!.userId, body.bevestigd === true);
    if (!uitkomst.ok) {
      return NextResponse.json(
        { success: false, error: { code: uitkomst.code, message: uitkomst.message, laatste_herinnering_op: uitkomst.laatste_herinnering_op ?? null } },
        { status: uitkomst.status }
      );
    }
    return NextResponse.json({ success: true, data: { id: uitkomst.id, mail: uitkomst.mail } });
  } catch (error) {
    return internalErrorResponse('aios-ruil-herinneren-planner', error);
  }
}
