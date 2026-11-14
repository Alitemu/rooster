/**
 * GET /api/aios/periode/[id]/download-wijzigingen - the wijzigingsgeschiedenis
 * of an AIOS quarter as a workbook: every change by hand to the roster and
 * every swap, with the reason and who did it (lib/aiosWijzigingen.ts). For
 * the AIOS's planner and the beheerder; an achterwacht period answers 404.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { xlsxDownload } from '@/lib/xlsxWrite';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosWijzigingenGeschiedenis } from '@/lib/aiosWijzigingen';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    return xlsxDownload(aiosWijzigingenGeschiedenis(period), 'wijzigingsgeschiedenis-aios', period.naam);
  } catch (error) {
    return internalErrorResponse('aios-download-wijzigingen', error);
  }
}
