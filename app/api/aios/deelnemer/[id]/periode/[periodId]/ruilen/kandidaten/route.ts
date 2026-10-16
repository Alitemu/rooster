/**
 * GET /api/aios/deelnemer/[id]/periode/[periodId]/ruilen/kandidaten?eenheid=<id>
 * - for one of the AIOS's own eenheden, every equal one of a colleague
 * they could swap it for without breaking a hard rule for either
 * (lib/aiosRuilen.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial } from '@/lib/auth-context';
import { aiosPeriodeBruikbaarVoor } from '@/lib/aiosToegang';
import { internalErrorResponse } from '@/lib/api-errors';
import { loadAiosPeriode } from '@/lib/aiosPreferences';
import { aiosRuilKandidaten } from '@/lib/aiosRuilen';

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
    const kandidaten = aiosRuilKandidaten(period, id, req.nextUrl.searchParams.get('eenheid') ?? '');
    if (!kandidaten) {
      return NextResponse.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Deze dienst is niet (meer) van jou of hij is al geweest.' } }, { status: 400 });
    }
    return NextResponse.json({ success: true, data: kandidaten });
  } catch (error) {
    return internalErrorResponse('aios-ruil-kandidaten', error);
  }
}
