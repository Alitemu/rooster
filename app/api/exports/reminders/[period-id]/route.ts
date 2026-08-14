/**
 * Reminders Export Route
 *
 * GET /api/exports/reminders/[period-id] - Get reminder templates for staff
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface ReminderTemplate {
  person_id: string;
  codenaam: string;
  email: string | null;
  personal_link: string;
  deadline: string;
  mailto_link: string;
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
    const baseUrl = process.env.BASE_URL || 'https://localhost:443';
    const linksStmt = db.prepare(`
      SELECT
        p.id as person_id,
        p.codenaam,
        pal.token,
        s.status as submission_status
      FROM dienstrooster_person_access_link pal
      JOIN dienstrooster_person p ON p.id = pal.person_id
      LEFT JOIN dienstrooster_submission s ON p.id = s.person_id AND s.schedule_period_id = ?
      WHERE pal.geldt_voor_periode_id = ?
      AND pal.ingetrokken_op IS NULL
      AND (s.status IS NULL OR s.status != 'BEVESTIGD')
      ORDER BY p.codenaam ASC
    `);

    const links = linksStmt.all(periodId, periodId) as any[];

    const reminders: ReminderTemplate[] = links.map((link) => {
      const personalLink = `${baseUrl}/person/${link.token}`;
      const deadline = new Date(period.deadline).toLocaleString();

      const subject = `Reminder: ${period.naam} Preferences Due`;
      const body = `Hello ${link.codenaam},

This is a reminder that your shift preferences for ${period.naam} are due by ${deadline}.

Please visit the following link to submit your preferences:
${personalLink}

Your input helps us create a fair roster that considers everyone's needs and availability.

If you have any questions, please contact the scheduler.

Thank you!`;

      const mailtoLink = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

      return {
        person_id: link.person_id,
        codenaam: link.codenaam,
        email: null, // No real emails stored
        personal_link: personalLink,
        deadline,
        mailto_link: mailtoLink,
      };
    });

    const response: ApiSuccessResponse<ReminderTemplate[]> = {
      success: true,
      data: reminders,
    };

    return NextResponse.json(response);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'EXPORT_ERROR',
        message: `Failed to generate reminders: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}
