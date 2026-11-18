/**
 * POST /api/planner/period/[id]/toegangslinks/[linkId]/intrekken - revoke
 * one personal link of the period. The beheerder only. The link is refused
 * from then on and the person's sessions end (lib/toegangslinks.ts), so
 * whoever came in through it is out at once. Revoking twice answers 409.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { trashedPeriodDenial } from '@/lib/periodTrash';
import { internalErrorResponse, unauthorizedResponse } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { trekToegangslinkIn } from '@/lib/toegangslinks';

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ success: false, error: { code, message } }, { status });

export async function POST(req: NextRequest, props: { params: Promise<{ id: string; linkId: string }> }): Promise<NextResponse> {
  const { id, linkId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const aiosNotYet = aiosNotYetDenial(id);
    if (aiosNotYet) return aiosNotYet;
    // Nothing changes in the prullenbak (lib/periodTrash.ts); its links are not usable there anyway.
    const inTrash = trashedPeriodDenial(id);
    if (inTrash) return inTrash;

    const uitkomst = trekToegangslinkIn(id, linkId);
    if (uitkomst.uitkomst === 'onbekend') return fail(404, 'LINK_NOT_FOUND', 'Deze link bestaat niet bij deze periode.');
    if (uitkomst.uitkomst === 'al_ingetrokken') return fail(409, 'LINK_ALREADY_REVOKED', 'Deze link is al ingetrokken.');
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'person_access_link',
      entiteitId: linkId,
      actie: 'UPDATE',
      nieuw: { wijziging: 'persoonlijke link ingetrokken', periode: id, persoon: uitkomst.person_id },
    });
    return NextResponse.json({ success: true, data: { codenaam: uitkomst.codenaam } });
  } catch (error) {
    return internalErrorResponse('toegangslinks-intrekken', error);
  }
}
