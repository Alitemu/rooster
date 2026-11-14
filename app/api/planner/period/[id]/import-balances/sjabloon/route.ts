/**
 * GET /api/planner/period/[id]/import-balances/sjabloon - the workbook to
 * fill in with the beginsaldi: a row per person who takes part in the
 * period, what an earlier import gave them already in it
 * (lib/importSjabloonBouwen.ts). The import takes only this layout.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { xlsxDownload } from '@/lib/xlsxWrite';
import { laadSjabloonPeriode, saldoSjabloon } from '@/lib/importSjabloonBouwen';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    // The achterwacht's step; the AIOS has its own (lib/aiosGeschiedenis.ts).
    const aiosNotYet = aiosNotYetDenial(id);
    if (aiosNotYet) return aiosNotYet;
    const period = laadSjabloonPeriode(id);
    if (!period) {
      return NextResponse.json({ success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } }, { status: 404 });
    }
    return xlsxDownload(saldoSjabloon(period), 'sjabloon-beginsaldo', 'periode');
  } catch (error) {
    return internalErrorResponse('import-balances-sjabloon', error);
  }
}
