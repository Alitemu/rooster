/**
 * POST /api/planner/period/[id]/toegangslinks/alles-intrekken - revoke every
 * personal link of the period that still works. The beheerder only. Everyone
 * with such a link is out at once (sessions end, lib/toegangslinks.ts) and
 * comes back with a new link: "Link kwijt?" or a new invitation. Links of
 * other periods stay. One audit entry, with the number.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { trashedPeriodDenial } from '@/lib/periodTrash';
import { internalErrorResponse, unauthorizedResponse } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { trekAlleToegangslinksIn } from '@/lib/toegangslinks';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
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

    const uitkomst = trekAlleToegangslinksIn(id);
    if (uitkomst.aantal > 0) {
      writeAuditLog({
        actorId: auth!.userId,
        entiteit: 'schedule_period',
        entiteitId: id,
        actie: 'UPDATE',
        nieuw: { wijziging: 'alle persoonlijke links ingetrokken', aantal: uitkomst.aantal, personen: uitkomst.personen },
      });
    }
    return NextResponse.json({ success: true, data: uitkomst });
  } catch (error) {
    return internalErrorResponse('toegangslinks-alles-intrekken', error);
  }
}
