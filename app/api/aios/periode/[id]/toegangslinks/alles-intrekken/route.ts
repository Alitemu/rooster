/**
 * POST /api/aios/periode/[id]/toegangslinks/alles-intrekken - revoke every
 * personal link of the AIOS period that still works. The beheerder only.
 * Everyone with such a link is out at once (sessions end,
 * lib/aiosToegangslinks.ts) and comes back with a new link. Links of other
 * periods stay. One audit entry, with the number. A copy of the
 * achterwacht's, not shared with it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { internalErrorResponse, unauthorizedResponse } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { trekAlleAiosToegangslinksIn } from '@/lib/aiosToegangslinks';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;

    const uitkomst = trekAlleAiosToegangslinksIn(period.id);
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
    return internalErrorResponse('aios-toegangslinks-alles-intrekken', error);
  }
}
