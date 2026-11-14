/**
 * POST /api/aios/periode/[id]/herinneringen { person_id?, laatste?, opnieuw? }
 * - a reminder to every AIOS who has not handed in yet (or to one), as one
 * verzendlijst to the AIOS's flow. Someone reminded in the last day is
 * skipped unless opnieuw is true: the button is easy to press twice.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { resolveBaseUrl } from '@/lib/baseUrl';
import { buildVerzendlijst } from '@/lib/aiosVerzendlijst';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosMailIngesteld, verstuurAiosVerzendlijst } from '@/lib/aiosMail';
import { claimAiosVerzending, AIOS_VERZENDING_BEZIG } from '@/lib/aiosInFlight';
import {
  aiosHerinnering,
  aiosMailMag,
  aiosNogNietIngediend,
  aiosPersoonlijkeLink,
  aiosRecentHerinnerd,
  logAiosHerinneringen,
} from '@/lib/aiosUitnodigen';
import { db } from '@/db/client';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  let release: (() => void) | null = null;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;

    const body = await parseJsonBody<{ person_id: unknown; laatste: unknown; opnieuw: unknown }>(req);
    if (body.person_id !== undefined && typeof body.person_id !== 'string') return aiosFout(400, 'VALIDATION_ERROR', 'Ongeldig verzoek.');
    if (!aiosMailIngesteld()) {
      return aiosFout(409, 'NOT_CONFIGURED', 'De mail voor de AIOS is nog niet ingesteld.');
    }
    const nietNu = aiosMailMag(period);
    if (nietNu) return aiosFout(409, 'PERIOD_NOT_OPEN', nietNu);

    // One send at a time (lib/aiosInFlight.ts): taken before the first await, shared with the automatic reminder.
    release = claimAiosVerzending(`herinneren:${period.id}`);
    if (!release) return aiosFout(409, 'BEZIG', AIOS_VERZENDING_BEZIG);

    let ontvangers = aiosNogNietIngediend(period);
    if (typeof body.person_id === 'string') {
      ontvangers = ontvangers.filter((o) => o.id === body.person_id);
      if (ontvangers.length === 0) return aiosFout(400, 'UNKNOWN_PERSON', 'Deze AIOS doet niet mee of heeft al ingediend.');
    }
    const recent = body.opnieuw === true ? new Set<string>() : aiosRecentHerinnerd(period.id, ontvangers.map((o) => o.id));
    const nu = ontvangers.filter((o) => !recent.has(o.id));
    if (nu.length === 0) {
      return NextResponse.json({ success: true, data: { aantal: 0, overgeslagen: recent.size } });
    }

    const laatste = body.laatste === true;
    const baseUrl = resolveBaseUrl(req);
    const berichten = db.transaction(() =>
      nu.map((o) => aiosHerinnering(period, o, aiosPersoonlijkeLink(o.id, period.id, baseUrl), laatste))
    )();
    const bezig = nu.filter((o) => o.groep === 'BEZIG').length;
    const result = await verstuurAiosVerzendlijst(
      buildVerzendlijst(
        {
          soort: laatste ? 'LAATSTE_HERINNERING' : 'HERINNERING',
          automatisch: false,
          periode: period.naam,
          deadline: period.deadline,
          groepen: { nog_niets_ingevuld: nu.length - bezig, nog_niet_ingediend: bezig },
        },
        berichten
      )
    );
    if (!result.ok) return aiosFout(502, 'MAIL_FAILED', result.message);
    logAiosHerinneringen(nu.map((o) => o.id), period.id, laatste);
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'schedule_period',
      entiteitId: period.id,
      actie: 'UPDATE',
      nieuw: { wijziging: 'herinneringen AIOS verstuurd', aantal: result.aantal },
    });
    return NextResponse.json({ success: true, data: { aantal: result.aantal, overgeslagen: recent.size } });
  } catch (error) {
    return internalErrorResponse('aios-herinneringen', error);
  } finally {
    release?.();
  }
}
