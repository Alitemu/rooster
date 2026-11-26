/**
 * GET /api/aios/periode/[id]/toegangslinks - the personal links of the AIOS
 * period with when they were made, last used and revoked (never the link
 * itself: only its hash is stored). The beheerder only; revoking is the
 * route below. A copy of the achterwacht's, not shared with it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { internalErrorResponse, unauthorizedResponse } from '@/lib/api-errors';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { lijstAiosToegangslinks } from '@/lib/aiosToegangslinks';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    return NextResponse.json({ success: true, data: lijstAiosToegangslinks(period.id) });
  } catch (error) {
    return internalErrorResponse('aios-toegangslinks-list', error);
  }
}
