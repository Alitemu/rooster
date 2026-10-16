/**
 * GET   /api/aios/periode/[id]/auto-herinneringen - what the AIOS's
 *       automatic reminders will do next for this period and what they
 *       already did (lib/aiosAutoHerinneringen.ts aiosAutoHerinnerStatus).
 * PATCH /api/aios/periode/[id]/auto-herinneringen { aan: boolean } - pause
 *       or resume them for this period. Reminders by hand are unaffected.
 * A copy of the achterwacht's /api/planner/period/[id]/auto-reminders for an
 * AIOS period only (docs/development/diensten.md, "Copied, not changed").
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosAutoHerinnerStatus, zetAiosAutoHerinneren } from '@/lib/aiosAutoHerinneringen';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    return NextResponse.json({ success: true, data: aiosAutoHerinnerStatus(period.id) });
  } catch (error) {
    return internalErrorResponse('aios-auto-herinneringen', error);
  }
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    const body = await parseJsonBody<{ aan: unknown }>(req);
    if (typeof body.aan !== 'boolean') {
      return aiosFout(400, 'VALIDATION_ERROR', 'Geef aan of automatische herinneringen aan of uit moeten.');
    }
    zetAiosAutoHerinneren(period.id, body.aan);
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'period',
      entiteitId: period.id,
      actie: 'UPDATE',
      nieuw: {
        wijziging: body.aan ? 'automatische herinneringen AIOS aan' : 'automatische herinneringen AIOS uit',
        auto_herinneren: body.aan,
      },
    });
    return NextResponse.json({ success: true, data: aiosAutoHerinnerStatus(period.id) });
  } catch (error) {
    return internalErrorResponse('aios-auto-herinneringen-zetten', error);
  }
}
