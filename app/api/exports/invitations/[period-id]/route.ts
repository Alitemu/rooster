/**
 * Invitations Export Route
 *
 * POST /api/exports/invitations/[period-id] - a workbook of everyone's personal link
 *
 * The plaintext access token is never persisted (only its hash), so it can't
 * be read back for an existing link. This route issues a fresh token for
 * every active pool member on each export, so the file always contains
 * working links.
 *
 * Those are issued ALONGSIDE any link a member already has, not instead of
 * them: this used to revoke the previous ones first, so downloading the
 * file a second time silently broke the link everyone had already been
 * sent. A link is only valid for its own period anyway, and being able to
 * go back to the original mail is worth more than retiring an older token.
 * See the reminders export for the same reasoning.
 *
 * POST, not GET: it mints credentials, and a GET that changes state is
 * reachable by anything that merely follows a URL with the planner's
 * cookie attached (a restored tab, a bookmark, an address-bar suggestion).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getInvitationPeriod, issuePeriodLinks, formatDeadline, rememberBaseUrl } from '@/lib/periodInvitations';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { trashedPeriodDenial } from '@/lib/periodTrash';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { resolveBaseUrl } from '@/lib/baseUrl';
import { xlsxDownload } from '@/lib/xlsxWrite';
import { writeAuditLog } from '@/lib/auditLog';
import type { ApiErrorResponse } from '@/types';

export async function POST(req: NextRequest, props: { params: Promise<{ 'period-id': string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const otherDienst = periodDienstDenial(auth, params['period-id']);
    if (otherDienst) return otherDienst;
    // The achterwacht's step; the AIOS's comes later (lib/aiosPeriod.ts).
    const aiosNotYet = aiosNotYetDenial(params['period-id']);
    if (aiosNotYet) return aiosNotYet;
    // Nothing changes in the prullenbak (lib/periodTrash.ts).
    const inTrash = trashedPeriodDenial(params['period-id']);
    if (inTrash) return inTrash;

    const periodId = params['period-id'];

    // Get period info
    const period = getInvitationPeriod(periodId);

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Periode niet gevonden',
        },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const baseUrl = resolveBaseUrl(req);
    rememberBaseUrl(period.id, baseUrl);
    const links = issuePeriodLinks(period, baseUrl);
    // One row for the batch, as staff-links writes one per link: who minted
    // links for which period, never the links themselves (audit 9).
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'schedule_period',
      entiteitId: period.id,
      actie: 'CREATE',
      nieuw: { wijziging: 'persoonlijke links aangemaakt voor de uitnodigingen', aantal: links.length },
    });
    const deadline = formatDeadline(period.deadline);
    return xlsxDownload(
      {
        name: 'Uitnodigingen',
        columns: [{ header: 'Naam' }, { header: 'Persoonlijke link' }, { header: 'Deadline' }],
        rows: links.map((link) => [link.codenaam, link.personalLink, deadline]),
      },
      'uitnodigingen',
      period.naam
    );
  } catch (error) {
    return internalErrorResponse('export-invitations', error);
  }
}
