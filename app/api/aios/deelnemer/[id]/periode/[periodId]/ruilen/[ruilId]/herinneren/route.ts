/**
 * POST /api/aios/deelnemer/[id]/periode/[periodId]/ruilen/[ruilId]/herinneren
 * { bevestigd: true } - the requester reminds the colleague of their open
 * request (lib/aiosRuilen.ts herinnerAiosRuil, where the audit row is
 * written). Without `bevestigd` nothing is sent and the answer says when the
 * last reminder went (BEVESTIGING).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { aiosPeriodeBruikbaarVoor, geenAiosDenial } from '@/lib/aiosToegang';
import { writeOnBehalfAuditLog } from '@/lib/auditLog';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { loadAiosPeriode } from '@/lib/aiosPreferences';
import { herinnerAiosRuil } from '@/lib/aiosRuilen';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string; periodId: string; ruilId: string }> }): Promise<NextResponse> {
  const { id, periodId, ruilId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id) ?? geenAiosDenial(id);
    if (denied) return denied;
    const period = loadAiosPeriode(periodId);
    if (!period || !aiosPeriodeBruikbaarVoor(auth!, id, period)) {
      return NextResponse.json({ success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } }, { status: 404 });
    }
    const body = await parseJsonBody<{ bevestigd?: unknown }>(req);
    const uitkomst = herinnerAiosRuil(period, ruilId, 'AANVRAGER', id, body.bevestigd === true);
    if (!uitkomst.ok) {
      return NextResponse.json(
        { success: false, error: { code: uitkomst.code, message: uitkomst.message, laatste_herinnering_op: uitkomst.laatste_herinnering_op ?? null } },
        { status: uitkomst.status }
      );
    }
    writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, id, { wijziging: 'herinnering voor ruil gestuurd door planner' });
    return NextResponse.json({ success: true, data: { id: uitkomst.id, mail: uitkomst.mail } });
  } catch (error) {
    return internalErrorResponse('aios-ruil-herinneren', error);
  }
}
