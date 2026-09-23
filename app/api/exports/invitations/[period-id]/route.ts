/**
 * Invitations Export Route
 *
 * POST /api/exports/invitations/[period-id] - Generate CSV with staff links
 *
 * The plaintext access token is never persisted (only its hash), so it can't
 * be read back for an existing link. This route issues a fresh token for
 * every active pool member on each export, so the CSV always contains
 * working links.
 *
 * Those are issued ALONGSIDE any link a member already has, not instead of
 * them: this used to revoke the previous ones first, so downloading the
 * CSV a second time silently broke the link everyone had already been
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
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { resolveBaseUrl } from '@/lib/baseUrl';
import { csvField, sanitizeFilenamePart } from '@/lib/csv';
import type { ApiErrorResponse } from '@/types';

export async function POST(req: NextRequest, props: { params: Promise<{ 'period-id': string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

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
    const deadline = formatDeadline(period.deadline);
    const csvLines: string[] = [
      'Naam,Persoonlijke link,Deadline',
      ...links.map((link) => [csvField(link.codenaam), csvField(link.personalLink), csvField(deadline)].join(',')),
    ];

    const csvContent = csvLines.join('\n');

    // Return as CSV file
    return new NextResponse(csvContent, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="invitations_${sanitizeFilenamePart(period.naam.replace(/ /g, '_'))}.csv"`,
      },
    });
  } catch (error) {
    return internalErrorResponse('export-invitations', error);
  }
}
