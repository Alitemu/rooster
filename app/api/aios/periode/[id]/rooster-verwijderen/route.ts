/**
 * POST /api/aios/periode/[id]/rooster-verwijderen - "Rooster verwijderen":
 * every dienst empty again and the period back to gesloten, so it can be
 * made again or reopened. Not once published, not while a generation runs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { periodStatusLabel } from '@/lib/aiosTeksten';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { AIOS_GENERATIE_LOOPT, aiosGeneratieLoopt, verwijderAiosRooster } from '@/lib/aiosGenereren';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    if (period.status !== 'GEGENEREERD') {
      return aiosFout(409, 'INVALID_STATUS', `Er is geen rooster om te verwijderen in status "${periodStatusLabel(period.status)}".`);
    }
    if (aiosGeneratieLoopt(period.id)) return aiosFout(409, 'GENERATION_RUNNING', AIOS_GENERATIE_LOOPT);
    const verwijderd = verwijderAiosRooster(period.id);
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'period',
      entiteitId: period.id,
      actie: 'DELETE',
      oud: { status: 'GEGENEREERD', diensten: verwijderd },
      nieuw: { wijziging: 'rooster AIOS verwijderd', status: 'GESLOTEN' },
    });
    return NextResponse.json({ success: true, data: { verwijderd, status: 'GESLOTEN' } });
  } catch (error) {
    return internalErrorResponse('aios-rooster-verwijderen', error);
  }
}
