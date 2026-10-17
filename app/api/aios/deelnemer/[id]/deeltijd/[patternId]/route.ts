/**
 * PATCH  /api/aios/deelnemer/[id]/deeltijd/[patternId] - change a part-time day
 * DELETE /api/aios/deelnemer/[id]/deeltijd/[patternId] - remove it
 *
 * The AIOS's copy of /api/person/[id]/parttime-patterns/[patternId]
 * (lib/aiosDeeltijd.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { geenAiosDenial } from '@/lib/aiosToegang';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeOnBehalfAuditLog } from '@/lib/auditLog';
import { verwijderPatroon, wijzigPatroon } from '@/lib/aiosDeeltijd';

type Props = { params: Promise<{ id: string; patternId: string }> };

export async function PATCH(req: NextRequest, props: Props): Promise<NextResponse> {
  const { id, patternId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id) ?? geenAiosDenial(id);
    if (denied) return denied;
    const { status, body } = wijzigPatroon(id, patternId, await parseJsonBody(req));
    if (status < 300) {
      writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, id, { wijziging: 'deeltijd gewijzigd door planner', pattern_id: patternId });
    }
    return NextResponse.json(body, { status });
  } catch (error) {
    return internalErrorResponse('aios-deeltijd-update', error);
  }
}

export async function DELETE(req: NextRequest, props: Props): Promise<NextResponse> {
  const { id, patternId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id) ?? geenAiosDenial(id);
    if (denied) return denied;
    const { status, body } = verwijderPatroon(id, patternId);
    if (status < 300) {
      writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, id, { wijziging: 'deeltijd verwijderd door planner', pattern_id: patternId });
    }
    return NextResponse.json(body, { status });
  } catch (error) {
    return internalErrorResponse('aios-deeltijd-delete', error);
  }
}
