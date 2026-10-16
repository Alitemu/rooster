/**
 * POST /api/aios/periode/[id]/publicatie-intrekken - a published roster back
 * to gegenereerd, every dienst kept, for one published by mistake;
 * publishing again starts voorlopig. No mail (lib/aiosPublicatie.ts, where
 * the audit row is written).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { trekAiosPublicatieIn } from '@/lib/aiosPublicatie';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    const uitkomst = trekAiosPublicatieIn(period, auth!.userId);
    if (!uitkomst.ok) {
      const { status, code, message, controle } = uitkomst;
      return NextResponse.json({ success: false, error: { code, message, ...(controle ? { controle } : {}) } }, { status });
    }
    return NextResponse.json({ success: true, data: { mail: uitkomst.mail } });
  } catch (error) {
    return internalErrorResponse('aios-publicatie-intrekken', error);
  }
}
