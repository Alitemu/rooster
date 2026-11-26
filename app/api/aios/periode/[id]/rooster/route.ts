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
import { aiosSolverInvoer } from '@/lib/aiosSolverInvoer';
import { nachtblokStand, nachtblokWaarschuwing } from '@/lib/aiosNachtblok';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    // Before the roster is made (1.6.0): too few part-timers known for the night blocks zo-di, in words or null
    // (lib/aiosNachtblok.ts). With the fte a new roster would be made with (`vers`), not the one of a made roster.
    const nachtblok_waarschuwing = nachtblokWaarschuwing(nachtblokStand(aiosSolverInvoer(period, 60, { vers: true })));
    return NextResponse.json({
      success: true,
      data: { ...laadAiosRooster(period), loopt: aiosGeneratieLoopt(period.id), generatie: laatsteAiosGeneratie(period.id) ?? null, nachtblok_waarschuwing },
    });
  } catch (error) {
    return internalErrorResponse('aios-rooster', error);
  }
}
