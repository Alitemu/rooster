/**
 * POST /api/exports/invitations/[period-id]/send - issues everyone in the
 * period a fresh personal link (same people as the CSV download, see
 * lib/periodInvitations.ts) and mails the invitations as a verzendlijst to
 * the Power Automate mailbox (lib/verzendlijstMail.ts).
 *
 * Checks the mail configuration before issuing anything, so a server that
 * can't send doesn't mint a batch of links nobody receives.
 *
 * Sent, this period becomes the active one (lib/activePeriod.ts); while
 * another period is active and not yet published, this is refused.
 */

import { checkMayBecomeActive, markInvited } from '@/lib/activePeriod';
import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { resolveBaseUrl } from '@/lib/baseUrl';
import {
  getInvitationPeriod,
  indicatieTekst,
  invitationBericht,
  issuePeriodLinks,
  rememberBaseUrl,
} from '@/lib/periodInvitations';
import { sendVerzendlijst, verzendlijstMailConfigured } from '@/lib/verzendlijstMail';
import { buildVerzendlijst } from '@/lib/verzendlijst';
import { checkInvitationsAllowed } from '@/lib/reminderGate';
import { computeMemberTargets } from '@/lib/rosterBands';

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export async function POST(req: NextRequest, props: { params: Promise<{ 'period-id': string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    if (!requirePlannerAccess(getAuthContextFromRequest(req))) return unauthorizedResponse();

    const period = getInvitationPeriod(params['period-id']);
    if (!period) return fail(404, 'NOT_FOUND', 'Periode niet gevonden');
    if (!verzendlijstMailConfigured()) {
      return fail(409, 'NOT_CONFIGURED', 'Automatisch versturen is nog niet ingesteld. Dat doe je bij Mailinstellingen.');
    }

    // Checked before any link is issued (lib/reminderGate.ts).
    const gate = checkInvitationsAllowed(period);
    if (!gate.allowed) return fail(409, gate.code, gate.message);
    // One active period at a time (lib/activePeriod.ts).
    const activation = checkMayBecomeActive(period.id);
    if (!activation.allowed) return fail(409, activation.code, activation.message);

    const baseUrl = resolveBaseUrl(req);
    rememberBaseUrl(period.id, baseUrl);
    const targets = computeMemberTargets(period.id);
    const berichten = issuePeriodLinks(period, baseUrl).map((link) =>
      invitationBericht(period, link.codenaam, link.personalLink, indicatieTekst(targets.get(link.personId)))
    );
    if (berichten.length === 0) return fail(400, 'EMPTY', 'Er doet niemand mee in deze periode.');

    const result = await sendVerzendlijst(
      buildVerzendlijst(
        { soort: 'UITNODIGING', automatisch: false, periode: period.naam, deadline: period.deadline },
        berichten
      )
    );
    if (!result.ok) return fail(502, 'MAIL_FAILED', result.message);
    markInvited(period.id);
    return NextResponse.json({ success: true, data: { aantal: result.aantal } });
  } catch (error) {
    return internalErrorResponse('export-invitations-send', error);
  }
}
