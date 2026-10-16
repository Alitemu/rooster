/**
 * GET /api/aios/periode/[id]/download-rooster - the AIOS's roster as a
 * workbook, a row per day and a column per dienst (lib/aiosRoosterDownloads.ts):
 * for the roosterbureau, the opleider and the ward. Once it is made.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { xlsxDownload } from '@/lib/xlsxWrite';
import { aiosRoosterPerDag } from '@/lib/aiosRoosterDownloads';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    if (period.status !== 'GEGENEREERD' && period.status !== 'GEPUBLICEERD') {
      return aiosFout(409, 'INVALID_STATUS', 'Er is nog geen rooster om te downloaden. Maak eerst het rooster.');
    }
    return xlsxDownload(aiosRoosterPerDag(period), 'rooster-aios', period.naam);
  } catch (error) {
    return internalErrorResponse('aios-download-rooster', error);
  }
}
