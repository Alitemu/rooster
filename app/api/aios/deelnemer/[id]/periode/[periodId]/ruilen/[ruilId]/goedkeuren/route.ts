/**
 * POST /api/aios/deelnemer/[id]/periode/[periodId]/ruilen/[ruilId]/goedkeuren -
 * the colleague says yes: the diensten change hands, if they still
 * can (nothing changed meanwhile, no hard rule broken now) (lib/aiosRuilen.ts, where the audit row is written).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { aiosPeriodeBruikbaarVoor, geenAiosDenial } from '@/lib/aiosToegang';
import { writeOnBehalfAuditLog } from '@/lib/auditLog';
import { internalErrorResponse } from '@/lib/api-errors';
import { loadAiosPeriode } from '@/lib/aiosPreferences';
import { keurAiosRuilGoed } from '@/lib/aiosRuilen';

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
    const uitkomst = keurAiosRuilGoed(period, id, ruilId);
    if (!uitkomst.ok) {
      return NextResponse.json({ success: false, error: { code: uitkomst.code, message: uitkomst.message } }, { status: uitkomst.status });
    }
    writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, id, { wijziging: 'ruil goedgekeurd door planner' });
    return NextResponse.json({ success: true, data: { id: uitkomst.id, mail: uitkomst.mail } });
  } catch (error) {
    return internalErrorResponse('aios-ruil-goedkeuren', error);
  }
}
