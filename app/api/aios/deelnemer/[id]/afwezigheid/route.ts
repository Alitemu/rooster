/**
 * GET  /api/aios/deelnemer/[id]/afwezigheid?period_id= - an AIOS's absences,
 *      with per absence how many of its days the period has and marks
 * POST /api/aios/deelnemer/[id]/afwezigheid - add one
 *
 * The AIOS's copy of /api/person/[id]/absences (lib/aiosDeeltijd.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { geenAiosDenial } from '@/lib/aiosToegang';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeOnBehalfAuditLog } from '@/lib/auditLog';
import { lijstAfwezigheden, maakAfwezigheid } from '@/lib/aiosDeeltijd';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id) ?? geenAiosDenial(id);
    if (denied) return denied;
    const { status, body } = lijstAfwezigheden(id, req.nextUrl.searchParams.get('period_id'), auth);
    return NextResponse.json(body, { status });
  } catch (error) {
    return internalErrorResponse('aios-afwezigheid-list', error);
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id) ?? geenAiosDenial(id);
    if (denied) return denied;
    const { status, body } = maakAfwezigheid(id, await parseJsonBody(req));
    if (status < 300) {
      writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, id, { wijziging: 'afwezigheid toegevoegd door planner' });
    }
    return NextResponse.json(body, { status });
  } catch (error) {
    return internalErrorResponse('aios-afwezigheid-create', error);
  }
}
