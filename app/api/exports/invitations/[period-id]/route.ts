/**
 * Invitations Export Route
 *
 * POST /api/exports/invitations/[period-id] - Generate CSV with staff links
 *
 * The plaintext access token is never persisted (only its hash), so it can't
 * be read back for an existing link. This route issues a fresh token for
 * every active pool member on each export (revoking any previous one for
 * this period) so the CSV always contains working links.
 *
 * POST, not GET, precisely because of that revoke-and-reissue: it changes
 * state, and the session cookie is SameSite=Lax, which still travels on a
 * cross-site top-level navigation. As a GET, any link a logged-in planner
 * could be induced to click (a chat message, an <img> in an email preview,
 * a bookmark gone stale) silently invalidated every personal link that had
 * already been sent out. Browsers never turn a link click into a POST.
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

    const revokeStmt = db.prepare(`
      UPDATE dienstrooster_person_access_link
      SET ingetrokken_op = ?
      WHERE person_id = ? AND geldt_voor_periode_id = ? AND ingetrokken_op IS NULL
    `);
    const insertStmt = db.prepare(`
      INSERT INTO dienstrooster_person_access_link
        (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    const links = members.map((member) => {
      revokeStmt.run(now, member.id, periodId);
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
