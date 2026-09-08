/**
 * Reminders Export Route
 *
 * GET /api/exports/reminders/[period-id] - Get reminder templates for staff
 * who haven't confirmed their preferences yet. Optional
 * ?days_before_deadline=N overrides how many days out to pretend it is;
 * defaults to the real number of days left before the period's actual
 * deadline. Either way, the tone (urgent/moderate/gentle) is decided by
 * where that number falls among the period's configured reminder
 * milestones (dienstrooster_reminder_schedule, see lib/reminderSchedule.ts)
 * rather than a fixed cutoff.
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
import { getActiveReminderMilestones, resolveReminderUrgency } from '@/lib/reminderSchedule';
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

// The "urgent" milestone is configurable per period (dienstrooster_reminder_
// schedule) and isn't necessarily "1 day out" - a planner can set the last
// milestone at, say, 3 days. Hardcoding "morgen" in the urgent subject line
// was factually wrong whenever the milestone that actually fired wasn't
// exactly 1 day before the deadline.
function relativeDeadlineWording(daysBeforeDeadline: number): string {
  if (daysBeforeDeadline <= 0) return 'vandaag';
  if (daysBeforeDeadline === 1) return 'morgen';
  return `over ${daysBeforeDeadline} dagen`;
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
    const periodStmt = db.prepare('SELECT naam, deadline, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?');
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

    // People in this period who have not confirmed their preferences yet -
    // membership must actually cover this period's own date range, same
    // filter every other "who belongs to this period" query uses (publish,
    // dashboard, progress, status-report, invitations export). Without it,
    // someone whose membership already ended (or hasn't started yet) still
    // got a reminder and a freshly issued personal link.
    const outstandingStmt = db.prepare(`
      SELECT p.id as person_id, p.codenaam
      FROM dienstrooster_person p
      JOIN dienstrooster_pool_membership pm ON pm.person_id = p.id
      JOIN dienstrooster_schedule_period sp ON sp.pool_id = pm.pool_id AND sp.id = ?
      LEFT JOIN dienstrooster_submission s ON s.person_id = p.id AND s.schedule_period_id = ?
      WHERE (s.status IS NULL OR s.status != 'BEVESTIGD')
        AND pm.geldig_vanaf <= sp.eind_datum AND pm.geldig_tot >= sp.start_datum
        AND p.actief = 1
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
    const milestones = getActiveReminderMilestones(periodId);
    const urgency = resolveReminderUrgency(daysBeforeDeadline, milestones);

    const reminders: ReminderTemplate[] = outstanding.map((person) => {
      revokeStmt.run(now, person.person_id, periodId);
      const token = generateAccessToken();
      insertStmt.run(crypto.randomUUID(), person.person_id, periodId, hashToken(token), now);

      const personalLink = `${baseUrl}/person/${token}`;
      const deadline = new Date(period.deadline).toLocaleString('nl-NL');

      const subject =
        urgency === 'urgent'
          ? `DRINGEND: voorkeuren voor ${period.naam} moeten ${relativeDeadlineWording(daysBeforeDeadline)} binnen zijn`
          : urgency === 'moderate'
            ? `Herinnering: voorkeuren voor ${period.naam} moeten binnenkort binnen zijn`
            : `Herinnering: voorkeuren voor ${period.naam} nog niet ontvangen`;

      const urgencyLine =
        urgency === 'urgent'
          ? `Dit is je laatste herinnering - je voorkeuren moeten uiterlijk ${deadline} binnen zijn.`
          : urgency === 'moderate'
            ? `Even een seintje: je hebt nog maar een paar dagen om je voorkeuren in te dienen, uiterlijk ${deadline}.`
            : `Dit is een herinnering dat je dienstvoorkeuren voor ${period.naam} uiterlijk ${deadline} binnen moeten zijn.`;

      const body = `Hoi ${person.codenaam},

${urgencyLine}

Ga naar de volgende link om je voorkeuren in te dienen:
${personalLink}

Jouw input helpt ons een eerlijk rooster te maken dat rekening houdt met ieders wensen en beschikbaarheid.

Heb je vragen? Neem dan contact op met de roosteraar.

Bedankt!`;

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
