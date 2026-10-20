/**
 * GET    /api/aios/mail-instellingen - the AIOS's mail: whether it is set
 *        up, the AIOS's flow mailbox, the last failure.
 * PUT    { verzendlijst_aan?, contact_planner? } - save the AIOS's flow mailbox
 *        and/or the planner's contact address for a voorlopig roster (empty:
 *        remove). The contact address is the AIOS planner's own, apart from
 *        the flow's mailbox, which the flow reads and a person does not.
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
import { aiosContactAdres, aiosMailStatus, bewaarAiosContactAdres, bewaarAiosStroomAdres } from '@/lib/aiosMail';
import { aiosMailWachtrij, flushAiosMailWachtrij } from '@/lib/aiosRuilMail';

const ALLEEN_BEHEERDER = 'Alleen de beheerder kan het adres van de stroom voor de AIOS wijzigen.';

export async function GET(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (visibleDienst(auth!) === 'ACHTERWACHT') return notThisDienstResponse();
    // What waits (kind, for whom, since when) is the beheerder's to see; a planner sees the number.
    return NextResponse.json({ success: true, data: { ...aiosMailStatus(), wachtrij_items: requireAdminAccess(auth) ? aiosMailWachtrij() : [] } });
  } catch (error) {
    return internalErrorResponse('aios-mail-get', error);
  }
}

function bewaar(auth: { userId: string }, velden: { verzendlijst_aan?: string; contact_planner?: string }) {
  const voor = { verzendlijst_aan: aiosMailStatus().verzendlijst_aan, contact_planner: aiosContactAdres() };
  for (const [veld, bewaarFn, entiteitId] of [
    ['verzendlijst_aan', bewaarAiosStroomAdres, 'aios.mail'],
    ['contact_planner', bewaarAiosContactAdres, 'aios.contact'],
  ] as const) {
    const adres = velden[veld];
    if (adres === undefined) continue;
    const result = bewaarFn(adres, auth.userId);
    if (!result.ok) {
      return NextResponse.json({ success: false, error: { code: 'INVALID_INPUT', message: result.message } }, { status: 400 });
    }
    writeAuditLog({
      actorId: auth.userId,
      entiteit: 'app_setting',
      entiteitId,
      actie: adres.trim() ? 'UPDATE' : 'DELETE',
      oud: { [veld]: voor[veld] },
      nieuw: adres.trim() ? { [veld]: adres.trim() } : null,
    });
  }
  // Mails that waited for a working address go now, not at the next hourly run. Not awaited: the queue may take a while.
  void flushAiosMailWachtrij();
  return NextResponse.json({ success: true, data: aiosMailStatus() });
}

export async function PUT(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (!requireAdminAccess(auth)) return forbiddenResponse(ALLEEN_BEHEERDER);
    const body = await parseJsonBody<{ verzendlijst_aan: unknown; contact_planner: unknown }>(req);
    const stroom = body.verzendlijst_aan;
    const contact = body.contact_planner;
    if ((stroom === undefined && contact === undefined) || (stroom !== undefined && typeof stroom !== 'string') || (contact !== undefined && typeof contact !== 'string')) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_INPUT', message: 'Vul het adres voor de verzendlijst van de AIOS of het contactadres van de planner in.' } },
        { status: 400 }
      );
    }
    return bewaar(auth!, { verzendlijst_aan: stroom as string | undefined, contact_planner: contact as string | undefined });
  } catch (error) {
    return internalErrorResponse('aios-mail-put', error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (!requireAdminAccess(auth)) return forbiddenResponse(ALLEEN_BEHEERDER);
    return bewaar(auth!, { verzendlijst_aan: '' });
  } catch (error) {
    return internalErrorResponse('aios-mail-delete', error);
  }
}
