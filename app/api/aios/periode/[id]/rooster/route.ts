/**
 * GET /api/aios/periode/[id]/rooster - the AIOS quarter's roster: per day
 * its diensten with who has them, and per AIOS their points and
 * dienstpercentage (lib/aiosRooster.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { laadAiosRooster } from '@/lib/aiosRooster';
import { aiosGeneratieLoopt, laatsteAiosGeneratie } from '@/lib/aiosGenereren';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    return NextResponse.json({ success: true, data: { ...laadAiosRooster(period), loopt: aiosGeneratieLoopt(period.id), generatie: laatsteAiosGeneratie(period.id) ?? null } });
  } catch (error) {
    return internalErrorResponse('aios-rooster', error);
  }
}
