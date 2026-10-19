/**
 * GET /api/aios/periode/[id] - an AIOS period as its page needs it: the
 * period, when the AIOS were invited, whether their mail is set up and how
 * many take part.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosIsDefinitief } from '@/lib/aiosDefinitief';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosDeelnemers, aiosPeriodeStand } from '@/lib/aiosUitnodigen';
import { aiosMailStatus } from '@/lib/aiosMail';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    const mail = aiosMailStatus();
    return NextResponse.json({
      success: true,
      data: {
        period,
        uitgenodigd_op: aiosPeriodeStand(id).uitgenodigd_op,
        mail_ingesteld: mail.ingesteld,
        aantal_deelnemers: aiosDeelnemers(period).length,
        // Published as voorlopig or as definitief: the status bar says which.
        definitief: aiosIsDefinitief(id),
      },
    });
  } catch (error) {
    return internalErrorResponse('aios-periode', error);
  }
}
