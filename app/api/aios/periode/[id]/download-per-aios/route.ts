/**
 * GET /api/aios/periode/[id]/download-per-aios - per AIOS their points,
 * dienstpercentage, diensten per soort and compensation days, as a
 * workbook (lib/aiosRoosterDownloads.ts), for the roosterbureau, which
 * plans the compensation days. Once the roster is made.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosIsDefinitief, NOG_NIET_DEFINITIEF } from '@/lib/aiosDefinitief';
import { xlsxDownload } from '@/lib/xlsxWrite';
import { aiosRoosterPerAios } from '@/lib/aiosRoosterDownloads';

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
    // For the roosterbureau: a voorlopig roster does not go there.
    if (!aiosIsDefinitief(period.id)) return aiosFout(409, 'NOT_DEFINITIEF', NOG_NIET_DEFINITIEF);
    return xlsxDownload(aiosRoosterPerAios(period), 'per-aios', period.naam);
  } catch (error) {
    return internalErrorResponse('aios-download-per-aios', error);
  }
}
