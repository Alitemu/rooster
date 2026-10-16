/**
 * GET  /api/aios/deelnemer/[id]/deeltijd - an AIOS's part-time days
 * POST /api/aios/deelnemer/[id]/deeltijd - add one
 *
 * The AIOS's copy of /api/person/[id]/parttime-patterns (lib/aiosDeeltijd.ts):
 * the same table, the AIOS's own sync. For the person themselves, or a
 * planner of their dienst acting for them (logged).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeOnBehalfAuditLog } from '@/lib/auditLog';
import { lijstPatronen, maakPatroon } from '@/lib/aiosDeeltijd';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const denied = personAccessDenial(getAuthContextFromRequest(req), id);
    if (denied) return denied;
    const { status, body } = lijstPatronen(id);
    return NextResponse.json(body, { status });
  } catch (error) {
    return internalErrorResponse('aios-deeltijd-list', error);
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;
    const { status, body } = maakPatroon(id, await parseJsonBody(req));
    if (status < 300) {
      writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, id, { wijziging: 'deeltijd toegevoegd door planner' });
    }
    return NextResponse.json(body, { status });
  } catch (error) {
    return internalErrorResponse('aios-deeltijd-create', error);
  }
}
