/**
 * Invitations Export Route
 *
 * GET /api/exports/invitations/[period-id] - Generate CSV with staff links
 *
 * The plaintext access token is never persisted (only its hash), so it can't
 * be read back for an existing link. This route issues a fresh token for
 * every active pool member on each export (revoking any previous one for
 * this period) so the CSV always contains working links.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { generateAccessToken, hashToken } from '@/lib/auth';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiErrorResponse } from '@/types';

export async function GET(
  req: NextRequest,
  { params }: { params: { 'period-id': string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params['period-id'];

    // Get period info
    const periodStmt = db.prepare('SELECT naam, deadline, pool_id FROM dienstrooster_schedule_period WHERE id = ?');
    const period = periodStmt.get(periodId) as any;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Period not found',
        },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Get active pool members for this period
    const membersStmt = db.prepare(`
      SELECT DISTINCT p.id, p.codenaam
      FROM dienstrooster_pool_membership pm
      JOIN dienstrooster_person p ON p.id = pm.person_id
      WHERE pm.pool_id = ?
      ORDER BY p.codenaam ASC
    `);
    const members = membersStmt.all(period.pool_id) as Array<{ id: string; codenaam: string }>;

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
    const baseUrl = process.env.BASE_URL || 'https://localhost:443';
    const csvLines: string[] = [
      'Name,Personal Link,Deadline',
      ...links.map((link) => {
        const personalLink = `${baseUrl}/person/${link.token}`;
        const deadline = new Date(period.deadline).toLocaleString();
        return `"${link.codenaam}","${personalLink}","${deadline}"`;
      }),
    ];

    const csvContent = csvLines.join('\n');

    // Return as CSV file
    return new NextResponse(csvContent, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="invitations_${period.naam.replace(/ /g, '_')}.csv"`,
      },
    });
  } catch (error) {
    return internalErrorResponse('export-invitations', error);
  }
}
