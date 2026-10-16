/**
 * POST /api/aios/periode/[id]/genereren { tijdslimiet_seconden? } - make the
 * AIOS quarter's roster with the AIOS's solver, in the background
 * (lib/aiosGenereren.ts); poll .../genereren/status. Only when the period
 * is gesloten, or gegenereerd to make it again (that replaces the whole
 * roster); one at a time per period (409).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { periodStatusLabel } from '@/lib/statusLabels';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { AIOS_GENERATIE_LOOPT, AIOS_TIJDSLIMIETEN, aiosGeneratieLoopt, startAiosGeneratie, type AiosTijdslimiet } from '@/lib/aiosGenereren';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;

    const body = await parseJsonBody<{ tijdslimiet_seconden: unknown }>(req);
    const tijdslimiet = body.tijdslimiet_seconden ?? 60;
    if (!AIOS_TIJDSLIMIETEN.includes(tijdslimiet as AiosTijdslimiet)) {
      return aiosFout(400, 'VALIDATION_ERROR', 'Kies 1, 2, 5 of 10 minuten.');
    }
    if (period.status !== 'GESLOTEN' && period.status !== 'GEGENEREERD') {
      return aiosFout(
        409,
        'INVALID_STATUS',
        `Een rooster maken kan als de periode gesloten is, niet in status "${periodStatusLabel(period.status)}". Sluit eerst de periode.`
      );
    }
    if (aiosGeneratieLoopt(period.id)) return aiosFout(409, 'GENERATION_RUNNING', AIOS_GENERATIE_LOOPT);

    const { row_version } = db.prepare('SELECT row_version FROM dienstrooster_schedule_period WHERE id = ?').get(period.id) as {
      row_version: number;
    };
    const jobId = startAiosGeneratie({ ...period, row_version }, tijdslimiet as AiosTijdslimiet);
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'period',
      entiteitId: period.id,
      actie: 'UPDATE',
      nieuw: { wijziging: 'rooster AIOS laten maken', tijdslimiet_seconden: tijdslimiet },
    });
    return NextResponse.json({ success: true, data: { job_id: jobId } }, { status: 202 });
  } catch (error) {
    return internalErrorResponse('aios-genereren', error);
  }
}
