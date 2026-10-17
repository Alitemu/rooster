/**
 * POST /api/aios/periode/[id]/links - a workbook with a fresh personal link
 * for every AIOS taking part, for when the mail cannot be used. Issued
 * alongside the links they already have (as the achterwacht's invitations
 * download does). POST: it mints credentials.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { resolveBaseUrl } from '@/lib/baseUrl';
import { writeAuditLog } from '@/lib/auditLog';
import { deadlineTekst } from '@/lib/aiosVerzendlijst';
import { xlsxDownload } from '@/lib/xlsxWrite';
import { laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosDeelnemers, aiosPersoonlijkeLink } from '@/lib/aiosUitnodigen';
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

    const baseUrl = resolveBaseUrl(req);
    const links = db.transaction(() =>
      aiosDeelnemers(period).map((d) => [d.codenaam, aiosPersoonlijkeLink(d.id, period.id, baseUrl)])
    )();
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'schedule_period',
      entiteitId: period.id,
      actie: 'CREATE',
      nieuw: { wijziging: 'persoonlijke links AIOS aangemaakt', aantal: links.length },
    });
    const deadline = deadlineTekst(period.deadline);
    return xlsxDownload(
      {
        name: 'Links AIOS',
        columns: [{ header: 'Codenaam' }, { header: 'Persoonlijke link' }, { header: 'Deadline' }],
        rows: links.map(([codenaam, link]) => [codenaam, link, deadline]),
      },
      'links-aios',
      period.naam
    );
  } catch (error) {
    return internalErrorResponse('aios-links', error);
  }
}
