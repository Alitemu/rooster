/**
 * GET /api/planner/period/[id]/toegangslinks - the personal links of the
 * period with when they were made, last used and revoked (never the link
 * itself: only its hash is stored). The beheerder only; revoking is the
 * route below. The AIOS has its own (app/api/aios/periode/[id]/toegangslinks).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { internalErrorResponse, unauthorizedResponse } from '@/lib/api-errors';
import { lijstToegangslinks } from '@/lib/toegangslinks';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const aiosNotYet = aiosNotYetDenial(id);
    if (aiosNotYet) return aiosNotYet;
    if (!db.prepare('SELECT 1 FROM dienstrooster_schedule_period WHERE id = ?').get(id)) {
      return NextResponse.json({ success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: lijstToegangslinks(id) });
  } catch (error) {
    return internalErrorResponse('toegangslinks-list', error);
  }
}
