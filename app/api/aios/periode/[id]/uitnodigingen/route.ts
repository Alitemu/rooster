/**
 * POST /api/aios/periode/[id]/uitnodigingen - a fresh personal link for every
 * AIOS taking part, mailed as one verzendlijst to the AIOS's own flow
 * (lib/aiosMail.ts) with the AIOS's own text (lib/aiosUitnodigen.ts). The
 * mail is checked before any link is issued, so a server that can't send
 * mints no links nobody receives.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { resolveBaseUrl } from '@/lib/baseUrl';
import { writeAuditLog } from '@/lib/auditLog';
import { buildVerzendlijst } from '@/lib/aiosVerzendlijst';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosMailIngesteld, verstuurAiosVerzendlijst } from '@/lib/aiosMail';
import {
  aiosAnderePeriodeActief,
  aiosDeelnemers,
  aiosMailMag,
  aiosPersoonlijkeLink,
  aiosUitnodiging,
  markeerAiosUitgenodigd,
} from '@/lib/aiosUitnodigen';
import { db } from '@/db/client';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;

    if (!aiosMailIngesteld()) {
      return aiosFout(
        409,
        'NOT_CONFIGURED',
        'De mail voor de AIOS is nog niet ingesteld. Daarvoor zijn het Gmail-account bij Mailinstellingen en het adres van de stroom voor de AIOS nodig.'
      );
    }
    const nietNu = aiosMailMag(period);
    if (nietNu) return aiosFout(409, 'PERIOD_NOT_OPEN', nietNu);
    const ander = aiosAnderePeriodeActief(period);
    if (ander) return aiosFout(409, 'OTHER_PERIOD_ACTIVE', ander);
    const deelnemers = aiosDeelnemers(period);
    if (deelnemers.length === 0) return aiosFout(400, 'EMPTY', 'Er doet nog geen AIOS mee in dit kwartaal.');

    const baseUrl = resolveBaseUrl(req);
    const berichten = db.transaction(() =>
      deelnemers.map((d) => aiosUitnodiging(period, d.codenaam, aiosPersoonlijkeLink(d.id, period.id, baseUrl)))
    )();
    const result = await verstuurAiosVerzendlijst(
      buildVerzendlijst({ soort: 'UITNODIGING', automatisch: false, periode: period.naam, deadline: period.deadline }, berichten)
    );
    if (!result.ok) return aiosFout(502, 'MAIL_FAILED', result.message);
    markeerAiosUitgenodigd(period.id, baseUrl);
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'schedule_period',
      entiteitId: period.id,
      actie: 'UPDATE',
      nieuw: { wijziging: 'uitnodigingen AIOS verstuurd', aantal: result.aantal },
    });
    return NextResponse.json({ success: true, data: { aantal: result.aantal } });
  } catch (error) {
    return internalErrorResponse('aios-uitnodigingen', error);
  }
}
