/**
 * GET /api/aios/periode/[id]/publicatie - where the AIOS's roster stands
 * (gemaakt, voorlopig, definitief), the check before publishing (an empty
 * dienst stops it, the rest are warnings) and whether the AIOS's mail is
 * set up (lib/aiosPublicatie.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosPublicatieStand } from '@/lib/aiosPublicatie';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    return NextResponse.json({ success: true, data: aiosPublicatieStand(period) });
  } catch (error) {
    return internalErrorResponse('aios-publicatie', error);
  }
}
