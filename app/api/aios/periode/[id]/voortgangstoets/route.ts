/**
 * GET /api/aios/periode/[id]/voortgangstoets - the date of the quarter's
 *     voortgangstoets and the fellow's night before it, and whether it may
 *     still change (lib/aiosVoortgangstoets.ts).
 * PUT /api/aios/periode/[id]/voortgangstoets { datum: 'YYYY-MM-DD' | null }
 *     - save it: that night out of the AIOS's quarter, the old one back.
 *     Until the roster is published; not while a generation runs (409),
 *     which plans with the nights as they were.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { periodStatusLabel } from '@/lib/statusLabels';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { AIOS_GENERATIE_LOOPT, aiosGeneratieLoopt } from '@/lib/aiosGenereren';
import { aiosVoortgangstoets, bewaarAiosVoortgangstoets } from '@/lib/aiosVoortgangstoets';

// Before the roster is made, or while it is not yet published.
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
    return NextResponse.json({ success: true, data: { ...aiosVoortgangstoets(period.id), mag_wijzigen: MAG.includes(period.status) } });
  } catch (error) {
    return internalErrorResponse('aios-voortgangstoets', error);
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
      return aiosFout(409, 'INVALID_STATUS', `De voortgangstoets ligt vast in status "${periodStatusLabel(period.status)}".`);
    }
    if (aiosGeneratieLoopt(period.id)) return aiosFout(409, 'GENERATION_RUNNING', AIOS_GENERATIE_LOOPT);

    const body = await parseJsonBody<{ datum: unknown }>(req);
    const oud = aiosVoortgangstoets(period.id);
    // No datum at all is odd input, not "none": a broken body must not clear it.
    const uitkomst = bewaarAiosVoortgangstoets(period, body.datum);
    if (!uitkomst.ok) return aiosFout(uitkomst.status, uitkomst.code, uitkomst.message);
    const nieuw = aiosVoortgangstoets(period.id);
    if (oud.datum !== nieuw.datum) {
      writeAuditLog({
        actorId: auth!.userId,
        entiteit: 'period',
        entiteitId: period.id,
        actie: 'UPDATE',
        oud: { voortgangstoets: oud.datum },
        nieuw: { wijziging: 'voortgangstoets AIOS', voortgangstoets: nieuw.datum },
      });
    }
    return NextResponse.json({ success: true, data: { ...nieuw, mag_wijzigen: true } });
  } catch (error) {
    return internalErrorResponse('aios-voortgangstoets-bewaren', error);
  }
}
