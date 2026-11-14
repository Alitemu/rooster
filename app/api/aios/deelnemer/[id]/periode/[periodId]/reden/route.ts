/**
 * PUT /api/aios/deelnemer/[id]/periode/[periodId]/reden - the optional
 * toelichting of one day the AIOS marked geblokkeerd or liever niet
 * (lib/aiosReden.ts). Body: { datum, tekst }; an empty tekst takes it away.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { aiosPeriodeBruikbaarVoor, geenAiosDenial } from '@/lib/aiosToegang';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeOnBehalfAuditLog } from '@/lib/auditLog';
import { aiosInvoerToegestaan, loadAiosPeriode } from '@/lib/aiosPreferences';
import { loadAiosRedenen, saveAiosReden } from '@/lib/aiosReden';

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ success: false, error: { code, message } }, { status });

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string; periodId: string }> }): Promise<NextResponse> {
  const { id, periodId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id) ?? geenAiosDenial(id);
    if (denied) return denied;

    const body = (await parseJsonBody(req)) as { datum?: unknown; tekst?: unknown } | null;
    const period = loadAiosPeriode(periodId);
    if (!period || !aiosPeriodeBruikbaarVoor(auth!, id, period)) return fail(404, 'PERIOD_NOT_FOUND', 'Periode niet gevonden');
    const invoer = aiosInvoerToegestaan(period);
    if (!invoer.ok) return fail(invoer.status, invoer.code, invoer.message);

    const result = saveAiosReden(id, period, body?.datum, body?.tekst);
    if (!result.ok) return fail(result.status, result.code, result.message);

    // Not the text: that stays private (lib/aiosReden.ts).
    writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, id, {
      wijziging: 'toelichting bij een dag gewijzigd door planner',
      periode_id: periodId,
    });
    return NextResponse.json({ success: true, data: { redenen: loadAiosRedenen(id, periodId) } });
  } catch (error) {
    return internalErrorResponse('aios-reden', error);
  }
}
