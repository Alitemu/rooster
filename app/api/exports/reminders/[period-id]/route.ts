/**
 * Reminders Export Route
 *
 * GET /api/exports/reminders/[period-id] - Get reminder templates for staff
 * who haven't confirmed their preferences yet. Optional
 * ?days_before_deadline=N picks the tone of the reminder (urgent close to
 * the deadline, gentle further out); defaults to the real number of days
 * left before the period's actual deadline.
 *
 * As with invitations, the plaintext access token is never persisted, so a
 * fresh one is issued (revoking any previous one for this period) for each
 * person included in the reminder batch.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { generateAccessToken, hashToken } from '@/lib/auth';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface ReminderTemplate {
  person_id: string;
  codenaam: string;
  email: string | null;
  personal_link: string;
  deadline: string;
  subject: string;
  body: string;
  mailto_link: string;
}

function daysBeforeDeadlineFromOverride(override: string | null, deadline: string): number {
  if (override !== null) {
    const parsed = parseInt(override, 10);
    if (!isNaN(parsed)) return parsed;
  }
  const msRemaining = new Date(deadline).getTime() - Date.now();
  return Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
}

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

    // People in this period who have not confirmed their preferences yet
    const outstandingStmt = db.prepare(`
      SELECT p.id as person_id, p.codenaam
      FROM dienstrooster_person p
      JOIN dienstrooster_pool_membership pm ON pm.person_id = p.id
      JOIN dienstrooster_schedule_period sp ON sp.pool_id = pm.pool_id AND sp.id = ?
      LEFT JOIN dienstrooster_submission s ON s.person_id = p.id AND s.schedule_period_id = ?
      WHERE s.status IS NULL OR s.status != 'BEVESTIGD'
      ORDER BY p.codenaam ASC
    `);
    const outstanding = outstandingStmt.all(periodId, periodId) as Array<{
      person_id: string;
      codenaam: string;
    }>;

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

    const baseUrl = process.env.BASE_URL || 'https://localhost:8010';
    const now = new Date().toISOString();

    const daysBeforeDeadline = daysBeforeDeadlineFromOverride(
      req.nextUrl.searchParams.get('days_before_deadline'),
      period.deadline
    );
    const urgency =
      daysBeforeDeadline <= 1
        ? 'urgent'
        : daysBeforeDeadline <= 3
          ? 'moderate'
          : 'gentle';

    const reminders: ReminderTemplate[] = outstanding.map((person) => {
      revokeStmt.run(now, person.person_id, periodId);
      const token = generateAccessToken();
      insertStmt.run(crypto.randomUUID(), person.person_id, periodId, hashToken(token), now);

      const personalLink = `${baseUrl}/person/${token}`;
      const deadline = new Date(period.deadline).toLocaleString();

      const subject =
        urgency === 'urgent'
          ? `URGENT: ${period.naam} Preferences Due Tomorrow`
          : urgency === 'moderate'
            ? `Reminder: ${period.naam} Preferences Due Soon`
            : `Reminder: ${period.naam} Preferences Due`;

      const urgencyLine =
        urgency === 'urgent'
          ? `This is your final reminder - your preferences are due by ${deadline}.`
          : urgency === 'moderate'
            ? `Just a heads up: only a few days left to submit your preferences, due by ${deadline}.`
            : `This is a reminder that your shift preferences for ${period.naam} are due by ${deadline}.`;

      const body = `Hello ${person.codenaam},

${urgencyLine}

Please visit the following link to submit your preferences:
${personalLink}

Your input helps us create a fair roster that considers everyone's needs and availability.

If you have any questions, please contact the scheduler.

Thank you!`;

      const mailtoLink = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

      return {
        person_id: person.person_id,
        codenaam: person.codenaam,
        email: null, // No real emails stored
        personal_link: personalLink,
        deadline,
        subject,
        body,
        mailto_link: mailtoLink,
      };
    });

    const response: ApiSuccessResponse<ReminderTemplate[]> = {
      success: true,
      data: reminders,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('export-reminders', error);
  }
}
