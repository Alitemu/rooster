/**
 * POST /api/planner/period/[id]/toegangslinks/persoon/[personId]/intrekken -
 * revoke every personal link of the period that still works for one person.
 * The beheerder only. The person is out at once (sessions end,
 * lib/toegangslinks.ts); links of other periods stay. One audit entry, with
 * the number. A person with no working link here answers 404 and nothing is
 * written (audit 1.2.2: 14 links of one person took 14 times "Intrekken").
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { trashedPeriodDenial } from '@/lib/periodTrash';
import { internalErrorResponse, unauthorizedResponse } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { trekToegangslinksVanPersoonIn } from '@/lib/toegangslinks';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string; personId: string }> }): Promise<NextResponse> {
  const { id, personId } = await props.params;
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

    const uitkomst = trekToegangslinksVanPersoonIn(id, personId);
    if (uitkomst.aantal === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'NO_WORKING_LINKS', message: 'Deze medewerker heeft geen werkende link voor deze periode.' } },
        { status: 404 }
      );
    }
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'schedule_period',
      entiteitId: id,
      actie: 'UPDATE',
      nieuw: { wijziging: 'persoonlijke links van een medewerker ingetrokken', persoon: personId, aantal: uitkomst.aantal },
    });
    return NextResponse.json({ success: true, data: uitkomst });
  } catch (error) {
    return internalErrorResponse('toegangslinks-persoon-intrekken', error);
  }
}
