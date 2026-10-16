/**
 * GET /api/aios/periode/[id]/geschiedenis-sjabloon - the workbook to fill in
 * with what the AIOS of this pool did before the app: a row per AIOS, what
 * was read in before already in it (lib/aiosGeschiedenis.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { xlsxDownload } from '@/lib/xlsxWrite';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosGeschiedenisSjabloon } from '@/lib/aiosGeschiedenis';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    return xlsxDownload(aiosGeschiedenisSjabloon(period), 'geschiedenis-aios', period.naam);
  } catch (error) {
    return internalErrorResponse('aios-geschiedenis-sjabloon', error);
  }
}
