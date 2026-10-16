/**
 * POST /api/aios/periode/[id]/rooster/wijzigen
 *   { wijzigingen: [{ dienst_id, aios_id: string | null, was: string | null }] }
 * - the AIOS's roster by hand: one dienst, or diensten of one block, to an
 * AIOS or empty (null), when each still has who the planner saw (`was`;
 * otherwise 409). Allowed against the hard rules: the answer gives the
 * warnings, and `terug`, the change that undoes it. Refused for someone not
 * in the pool on the day. Only gegenereerd and nothing being made
 * (lib/aiosHandmatig.ts); the audit row is written there, with the change.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { magAiosRoosterWijzigen, wijzigAiosRooster } from '@/lib/aiosHandmatig';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    const nee = magAiosRoosterWijzigen(period);
    if (nee) return aiosFout(nee.status, nee.code, nee.message);
    const body = await parseJsonBody<{ wijzigingen: unknown }>(req);
    const uitkomst = wijzigAiosRooster(period, body.wijzigingen, auth!.userId);
    if (!uitkomst.ok) return aiosFout(uitkomst.status, uitkomst.code, uitkomst.message);
    return NextResponse.json({ success: true, data: { waarschuwingen: uitkomst.waarschuwingen, terug: uitkomst.terug } });
  } catch (error) {
    return internalErrorResponse('aios-rooster-wijzigen', error);
  }
}
