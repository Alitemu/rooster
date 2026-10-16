/**
 * PUT /api/aios/deelnemer/[id]/periode/[periodId]/wens - what an AIOS asks besides the
 * diensten they mark: "4 avonden", "4 nachten", "twee dagdiensten", the
 * inwerkperiode, a training interruption and a short general request
 * (lib/aiosPreferences.ts saveAiosWens).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { aiosPeriodeBruikbaarVoor } from '@/lib/aiosToegang';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeOnBehalfAuditLog } from '@/lib/auditLog';
import { aiosInvoerToegestaan, loadAiosPeriode, loadAiosWens, saveAiosWens } from '@/lib/aiosPreferences';

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ success: false, error: { code, message } }, { status });

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string; periodId: string }> }): Promise<NextResponse> {
  const { id, periodId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;

    const body = await parseJsonBody(req);
    const period = loadAiosPeriode(periodId);
    if (!period || !aiosPeriodeBruikbaarVoor(auth!, id, period)) return fail(404, 'PERIOD_NOT_FOUND', 'Periode niet gevonden');
    const invoer = aiosInvoerToegestaan(period);
    if (!invoer.ok) return fail(invoer.status, invoer.code, invoer.message);

    const result = saveAiosWens(id, period, body);
    if (!result.ok) return fail(result.status, result.code, result.message);

    writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, id, {
      wijziging: 'wensen gewijzigd door planner',
      periode_id: periodId,
    });
    return NextResponse.json({ success: true, data: loadAiosWens(id, periodId) });
  } catch (error) {
    return internalErrorResponse('aios-wens', error);
  }
}
