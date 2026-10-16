/**
 * PATCH  /api/aios/deelnemer/[id]/afwezigheid/[absenceId] - change an absence
 * DELETE /api/aios/deelnemer/[id]/afwezigheid/[absenceId] - remove it
 *
 * The AIOS's copy of /api/person/[id]/absences/[absenceId] (lib/aiosDeeltijd.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeOnBehalfAuditLog } from '@/lib/auditLog';
import { verwijderAfwezigheid, wijzigAfwezigheid } from '@/lib/aiosDeeltijd';

type Props = { params: Promise<{ id: string; absenceId: string }> };

export async function PATCH(req: NextRequest, props: Props): Promise<NextResponse> {
  const { id, absenceId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;
    const { status, body } = wijzigAfwezigheid(id, absenceId, await parseJsonBody(req));
    if (status < 300) {
      writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, id, { wijziging: 'afwezigheid gewijzigd door planner', absence_id: absenceId });
    }
    return NextResponse.json(body, { status });
  } catch (error) {
    return internalErrorResponse('aios-afwezigheid-update', error);
  }
}

export async function DELETE(req: NextRequest, props: Props): Promise<NextResponse> {
  const { id, absenceId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;
    const { status, body } = verwijderAfwezigheid(id, absenceId);
    if (status < 300) {
      writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, id, { wijziging: 'afwezigheid verwijderd door planner', absence_id: absenceId });
    }
    return NextResponse.json(body, { status });
  } catch (error) {
    return internalErrorResponse('aios-afwezigheid-delete', error);
  }
}
