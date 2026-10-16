/**
 * GET /api/aios/periode/[id]/rooster/kandidaten?dienst=<id>&heel=1 - for a
 * dienst, or (heel=1) every dienst of its block, who has it now and per
 * AIOS taking part whether they can have it, with the warnings and their
 * dienstpercentage after it (lib/aiosHandmatig.ts). Only while the roster
 * can change by hand: gegenereerd or gepubliceerd, and nothing being made.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosKandidaten, kiesDiensten, magAiosRoosterWijzigen } from '@/lib/aiosHandmatig';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
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
    const params = req.nextUrl.searchParams;
    const keuze = kiesDiensten(period, params.get('dienst'), params.get('heel') === '1');
    if (!keuze.ok) return aiosFout(400, 'VALIDATION_ERROR', keuze.message);
    return NextResponse.json({ success: true, data: aiosKandidaten(period, keuze.diensten) });
  } catch (error) {
    return internalErrorResponse('aios-rooster-kandidaten', error);
  }
}
