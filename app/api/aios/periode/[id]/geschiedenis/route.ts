/**
 * GET  /api/aios/periode/[id]/geschiedenis - what the AIOS of this pool did
 *      before the app, as read in, with what it means for their first
 *      quarter in the app (lib/aiosGeschiedenis.ts).
 * POST /api/aios/periode/[id]/geschiedenis { bestand: base64 .xlsx, toepassen, bevestigd? }
 *      - check the file (toepassen false: per AIOS what it would mean, and
 *      every problem) or save it, replacing what the pool had: 409
 *      GESCHIEDENIS_BESTAAT until bevestigd is true when there is a history. It counts
 *      from the next time a roster is made.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosGeschiedenisStand, importeerAiosGeschiedenis } from '@/lib/aiosGeschiedenis';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    return NextResponse.json({ success: true, data: aiosGeschiedenisStand(period) });
  } catch (error) {
    return internalErrorResponse('aios-geschiedenis', error);
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    const body = await parseJsonBody<{ bestand: unknown; toepassen: unknown; bevestigd: unknown }>(req);
    const uitkomst = importeerAiosGeschiedenis(period, body.bestand, body.toepassen === true, body.bevestigd === true);
    if (!uitkomst.ok) {
      const { status, code, message, plan } = uitkomst;
      return NextResponse.json({ success: false, error: { code, message, ...(plan ? { plan } : {}) } }, { status });
    }
    if (uitkomst.toegepast) {
      writeAuditLog({
        actorId: auth!.userId,
        entiteit: 'pool',
        entiteitId: period.pool_id,
        actie: 'UPDATE',
        nieuw: { wijziging: 'geschiedenis AIOS van voor de app ingelezen', periode: period.id, aios: uitkomst.plan.rijen.length },
      });
    }
    return NextResponse.json({ success: true, data: { plan: uitkomst.plan, toegepast: uitkomst.toegepast } });
  } catch (error) {
    return internalErrorResponse('aios-geschiedenis-inlezen', error);
  }
}
