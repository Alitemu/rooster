/**
 * POST /api/aios/periode/[id]/toegangslinks/[linkId]/intrekken - revoke one
 * personal link of the AIOS period. The beheerder only. The link is refused
 * from then on and the person's sessions end (lib/aiosToegangslinks.ts), so
 * whoever came in through it is out at once. Revoking twice answers 409.
 * A copy of the achterwacht's, not shared with it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { internalErrorResponse, unauthorizedResponse } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { trekAiosToegangslinkIn } from '@/lib/aiosToegangslinks';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string; linkId: string }> }): Promise<NextResponse> {
  const { id, linkId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;

    const uitkomst = trekAiosToegangslinkIn(period.id, linkId);
    if (uitkomst.uitkomst === 'onbekend') return aiosFout(404, 'LINK_NOT_FOUND', 'Deze link bestaat niet bij deze periode.');
    if (uitkomst.uitkomst === 'al_ingetrokken') return aiosFout(409, 'LINK_ALREADY_REVOKED', 'Deze link is al ingetrokken.');
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'person_access_link',
      entiteitId: linkId,
      actie: 'UPDATE',
      nieuw: { wijziging: 'persoonlijke link ingetrokken', periode: id, persoon: uitkomst.person_id },
    });
    return NextResponse.json({ success: true, data: { codenaam: uitkomst.codenaam } });
  } catch (error) {
    return internalErrorResponse('aios-toegangslinks-intrekken', error);
  }
}
