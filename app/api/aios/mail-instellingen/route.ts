/**
 * GET    /api/aios/mail-instellingen - the AIOS's mail: whether it is set
 *        up, the AIOS's flow mailbox, the last failure.
 * PUT    { verzendlijst_aan } - save the AIOS's flow mailbox (empty: remove).
 * DELETE - remove it. No mail goes to the AIOS any more.
 *
 * The Gmail account is the one of Mailinstellingen (/api/planner/mail-settings),
 * shared and set by the beheerder there; this is only the AIOS's own flow
 * (lib/aiosMail.ts). Saving and removing are for the beheerder: whoever
 * could point it elsewhere would get the AIOS's personal links. The
 * achterwacht's planner sees nothing of it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, forbiddenResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { notThisDienstResponse, visibleDienst } from '@/lib/dienstAccess';
import { writeAuditLog } from '@/lib/auditLog';
import { aiosMailStatus, bewaarAiosStroomAdres } from '@/lib/aiosMail';

const ALLEEN_BEHEERDER = 'Alleen de beheerder kan het adres van de stroom voor de AIOS wijzigen.';

export async function GET(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (visibleDienst(auth!) === 'ACHTERWACHT') return notThisDienstResponse();
    return NextResponse.json({ success: true, data: aiosMailStatus() });
  } catch (error) {
    return internalErrorResponse('aios-mail-get', error);
  }
}

function bewaar(auth: { userId: string }, adres: string) {
  const voor = aiosMailStatus().verzendlijst_aan;
  const result = bewaarAiosStroomAdres(adres, auth.userId);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: { code: 'INVALID_INPUT', message: result.message } }, { status: 400 });
  }
  writeAuditLog({
    actorId: auth.userId,
    entiteit: 'app_setting',
    entiteitId: 'aios.mail',
    actie: adres.trim() ? 'UPDATE' : 'DELETE',
    oud: { verzendlijst_aan: voor },
    nieuw: adres.trim() ? { verzendlijst_aan: adres.trim() } : null,
  });
  return NextResponse.json({ success: true, data: aiosMailStatus() });
}

export async function PUT(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (!requireAdminAccess(auth)) return forbiddenResponse(ALLEEN_BEHEERDER);
    const body = await parseJsonBody<{ verzendlijst_aan: unknown }>(req);
    if (typeof body.verzendlijst_aan !== 'string') {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_INPUT', message: 'Vul het adres voor de verzendlijst van de AIOS in.' } },
        { status: 400 }
      );
    }
    return bewaar(auth!, body.verzendlijst_aan);
  } catch (error) {
    return internalErrorResponse('aios-mail-put', error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (!requireAdminAccess(auth)) return forbiddenResponse(ALLEEN_BEHEERDER);
    return bewaar(auth!, '');
  } catch (error) {
    return internalErrorResponse('aios-mail-delete', error);
  }
}
