/**
 * GET /api/periods/[id]/prior-assignments/sjabloon - the workbook to fill in
 * for "Eerdere toewijzingen": a row per day of the carry-over window, in the
 * columns of the roster download, with what is entered already
 * (lib/importSjabloonBouwen.ts). The roster download itself goes in as well.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { xlsxDownload } from '@/lib/xlsxWrite';
import { eerdereToewijzingenSjabloon, laadSjabloonPeriode } from '@/lib/importSjabloonBouwen';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    // The achterwacht's step; the AIOS's comes later (lib/aiosPeriod.ts).
    const aiosNotYet = aiosNotYetDenial(id);
    if (aiosNotYet) return aiosNotYet;
    const period = laadSjabloonPeriode(id);
    if (!period) {
      return NextResponse.json({ success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } }, { status: 404 });
    }
    return xlsxDownload(eerdereToewijzingenSjabloon(period), 'sjabloon-eerdere-toewijzingen', 'periode');
  } catch (error) {
    return internalErrorResponse('prior-assignments-sjabloon', error);
  }
}
