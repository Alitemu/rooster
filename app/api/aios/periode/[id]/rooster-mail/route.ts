/**
 * POST /api/aios/periode/[id]/rooster-mail - the mail of the publication
 * once more, to every AIOS, when it failed (lib/aiosPublicatie.ts
 * mailAiosRoosterOpnieuw). One send at a time (lib/aiosInFlight.ts). The
 * audit row is written there.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { mailAiosRoosterOpnieuw } from '@/lib/aiosPublicatie';
import { claimAiosVerzending, AIOS_VERZENDING_BEZIG } from '@/lib/aiosInFlight';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  let release: (() => void) | null = null;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    // One send at a time (lib/aiosInFlight.ts): taken before the first await.
    release = claimAiosVerzending(`rooster-mail:${period.id}`);
    if (!release) return aiosFout(409, 'BEZIG', AIOS_VERZENDING_BEZIG);
    const uitkomst = await mailAiosRoosterOpnieuw(period, auth!.userId);
    if (!uitkomst.ok) {
      const { status, code, message } = uitkomst;
      return NextResponse.json({ success: false, error: { code, message } }, { status });
    }
    return NextResponse.json({ success: true, data: { mail: uitkomst.mail } });
  } catch (error) {
    return internalErrorResponse('aios-rooster-mail', error);
  } finally {
    release?.();
  }
}
