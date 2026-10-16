/**
 * GET  /api/aios/deelnemer/[id]/periode/[periodId]/ruilen - an AIOS's swap
 *      page: their own eenheden still to come, the requests from and to
 *      them (lib/aiosRuilen.ts).
 * POST .../ruilen { aangeboden, gevraagd, toelichting? } - ask a colleague
 *      to swap: an eenheid of their own for an equal one of the
 *      colleague's, if it breaks no hard rule for either. Only on a
 *      published roster. The audit row is written there.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial } from '@/lib/auth-context';
import { aiosPeriodeBruikbaarVoor } from '@/lib/aiosToegang';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { loadAiosPeriode } from '@/lib/aiosPreferences';
import { aiosRuilOverzicht, vraagAiosRuilAan } from '@/lib/aiosRuilen';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string; periodId: string }> }): Promise<NextResponse> {
  const { id, periodId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;
    const period = loadAiosPeriode(periodId);
    if (!period || !aiosPeriodeBruikbaarVoor(auth!, id, period)) {
      return NextResponse.json({ success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } }, { status: 404 });
    }
    if (period.status !== 'GEPUBLICEERD') {
      return NextResponse.json({ success: false, error: { code: 'NOT_PUBLISHED', message: 'Ruilen kan als het rooster gepubliceerd is.' } }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: aiosRuilOverzicht(period, id) });
  } catch (error) {
    return internalErrorResponse('aios-ruilen', error);
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string; periodId: string }> }): Promise<NextResponse> {
  const { id, periodId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;
    const period = loadAiosPeriode(periodId);
    if (!period || !aiosPeriodeBruikbaarVoor(auth!, id, period)) {
      return NextResponse.json({ success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } }, { status: 404 });
    }
    const body = await parseJsonBody<{ aangeboden: unknown; gevraagd: unknown; toelichting: unknown }>(req);
    const uitkomst = vraagAiosRuilAan(period, id, body.aangeboden, body.gevraagd, body.toelichting);
    if (!uitkomst.ok) {
      return NextResponse.json({ success: false, error: { code: uitkomst.code, message: uitkomst.message } }, { status: uitkomst.status });
    }
    return NextResponse.json({ success: true, data: { id: uitkomst.id, mail: uitkomst.mail } });
  } catch (error) {
    return internalErrorResponse('aios-ruil-aanvragen', error);
  }
}
