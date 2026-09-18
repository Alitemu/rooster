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
import { db } from '@/db/client';
import { generateAccessToken, hashToken } from '@/lib/auth';
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
    const periodStmt = db.prepare('SELECT naam, deadline, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?');
    const period = periodStmt.get(periodId) as any;

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

    // Get pool members whose membership window actually covers this period -
    // same date-range filter every other "who belongs to this period" query
    // uses (publish, dashboard, progress, status-report). Without it, someone
    // whose membership already ended (or hasn't started yet) still got a
    // freshly issued, valid personal link for a period they have no part in.
    const membersStmt = db.prepare(`
      SELECT DISTINCT p.id, p.codenaam
      FROM dienstrooster_pool_membership pm
      JOIN dienstrooster_person p ON p.id = pm.person_id
      WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1
      ORDER BY p.codenaam ASC
    `);
    const members = membersStmt.all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ id: string; codenaam: string }>;

    const insertStmt = db.prepare(`
      INSERT INTO dienstrooster_person_access_link
        (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    const links = members.map((member) => {
      // Added to this member's links, not replacing them - an earlier
      // invitation keeps working (see the module docstring).
      const token = generateAccessToken();
      insertStmt.run(crypto.randomUUID(), member.id, periodId, hashToken(token), now);
      return { codenaam: member.codenaam, token };
    });

    // Build CSV content
    const baseUrl = resolveBaseUrl(req);
    const csvLines: string[] = [
      'Naam,Persoonlijke link,Deadline',
      ...links.map((link) => {
        const personalLink = `${baseUrl}/person/${link.token}`;
        const deadline = new Date(period.deadline).toLocaleString('nl-NL');
        return [csvField(link.codenaam), csvField(personalLink), csvField(deadline)].join(',');
      }),
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
