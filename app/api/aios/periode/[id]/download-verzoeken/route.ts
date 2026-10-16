/**
 * GET /api/aios/periode/[id]/download-verzoeken - "Verzoeken per AIOS" of
 * an AIOS quarter as a workbook: a row per AIOS with what they asked
 * besides their marks (4 avonden, 4 nachten, twee dagdiensten, inwerken,
 * onderbreking, opmerking), part-time days, absences and the 50% counters
 * (lib/aiosDownloads.ts). For the AIOS's planner and the beheerder; an
 * achterwacht period answers 404.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { xlsxDownload } from '@/lib/xlsxWrite';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosVerzoekenPerAios } from '@/lib/aiosDownloads';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    return xlsxDownload(aiosVerzoekenPerAios(period), 'verzoeken-aios', period.naam);
  } catch (error) {
    return internalErrorResponse('aios-download-verzoeken', error);
  }
}
