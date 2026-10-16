/**
 * GET /api/aios/periode/[id]/feestdagblokken - the questions about the
 *     blocks around feestdagen and New Year's Eve, with what the planner
 *     chose so far (lib/aiosFeestdagBlokken.ts).
 * PUT /api/aios/periode/[id]/feestdagblokken
 *     { keuzes?: [{ blok_id, keuze: 'HEEL' | 'OPKNIPPEN' }], oudjaar_aantal?: 1 | 2 }
 *     - save them. They count from the next generation on; not while one
 *     runs (409), whose answer was made with the old ones.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { periodStatusLabel } from '@/lib/statusLabels';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { AIOS_GENERATIE_LOOPT, aiosGeneratieLoopt } from '@/lib/aiosGenereren';
import { aiosFeestdagVragen, bewaarAiosFeestdagKeuzes } from '@/lib/aiosFeestdagBlokken';

// Before the roster is made, or to make it again.
const MAG = ['CONCEPT', 'OPEN', 'GESLOTEN', 'GEGENEREERD'];

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    return NextResponse.json({ success: true, data: aiosFeestdagVragen(period) });
  } catch (error) {
    return internalErrorResponse('aios-feestdagblokken', error);
  }
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    if (!MAG.includes(period.status)) {
      return aiosFout(409, 'INVALID_STATUS', `De blokken rond feestdagen liggen vast in status "${periodStatusLabel(period.status)}".`);
    }
    if (aiosGeneratieLoopt(period.id)) return aiosFout(409, 'GENERATION_RUNNING', AIOS_GENERATIE_LOOPT);

    const body = await parseJsonBody<{ keuzes: unknown; oudjaar_aantal: unknown }>(req);
    const oud = aiosFeestdagVragen(period);
    const uitkomst = bewaarAiosFeestdagKeuzes(period, body.keuzes, body.oudjaar_aantal);
    if (!uitkomst.ok) return aiosFout(uitkomst.status, uitkomst.code, uitkomst.message);
    const nieuw = aiosFeestdagVragen(period);
    const keuzes = (v: typeof oud) =>
      Object.fromEntries([...v.groepen.flatMap((g) => g.blokken), ...v.losse].map((b) => [b.blok_id, b.keuze]));
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'period',
      entiteitId: period.id,
      actie: 'UPDATE',
      oud: { blokken: keuzes(oud), oudjaar_aantal: oud.oudjaar?.aantal ?? null },
      nieuw: { wijziging: 'blokken rond feestdagen AIOS', blokken: keuzes(nieuw), oudjaar_aantal: nieuw.oudjaar?.aantal ?? null },
    });
    return NextResponse.json({ success: true, data: nieuw });
  } catch (error) {
    return internalErrorResponse('aios-feestdagblokken-bewaren', error);
  }
}
