/**
 * Invitations Export Route
 *
 * GET /api/exports/invitations/[period-id] - Generate CSV with staff links
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import type { ApiErrorResponse } from '@/types';

interface StaffLink {
  codenaam: string;
  token: string;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { 'period-id': string } }
): Promise<NextResponse> {
  try {
    const periodId = params['period-id'];

    // Get period info
    const periodStmt = db.prepare('SELECT naam, deadline FROM dienstrooster_schedule_period WHERE id = ?');
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

    // Get all staff with access links
    const linksStmt = db.prepare(`
      SELECT
        p.codenaam,
        pal.token
      FROM dienstrooster_person_access_link pal
      JOIN dienstrooster_person p ON p.id = pal.person_id
      WHERE pal.geldt_voor_periode_id = ?
      AND pal.ingetrokken_op IS NULL
      ORDER BY p.codenaam ASC
    `);

    const links = linksStmt.all(periodId) as StaffLink[];

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
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'EXPORT_ERROR',
        message: `Failed to generate invitations: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}
