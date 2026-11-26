/**
 * POST /api/aios/periode/[id]/toegangslinks/persoon/[personId]/intrekken -
 * revoke every personal link of the AIOS period that still works for one
 * person. The beheerder only. The person is out at once (sessions end,
 * lib/aiosToegangslinks.ts); links of other periods stay. One audit entry,
 * with the number. A person with no working link here answers 404 and
 * nothing is written. A copy of the achterwacht's, not shared with it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { internalErrorResponse, unauthorizedResponse } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { trekAiosToegangslinksVanPersoonIn } from '@/lib/aiosToegangslinks';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string; personId: string }> }): Promise<NextResponse> {
  const { id, personId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;

    const uitkomst = trekAiosToegangslinksVanPersoonIn(period.id, personId);
    if (uitkomst.aantal === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'NO_WORKING_LINKS', message: 'Deze AIOS heeft geen werkende link voor deze periode.' } },
        { status: 404 }
      );
    }
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'schedule_period',
      entiteitId: id,
      actie: 'UPDATE',
      nieuw: { wijziging: 'persoonlijke links van een AIOS ingetrokken', persoon: personId, aantal: uitkomst.aantal },
    });
    return NextResponse.json({ success: true, data: uitkomst });
  } catch (error) {
    return internalErrorResponse('aios-toegangslinks-persoon-intrekken', error);
  }
}
