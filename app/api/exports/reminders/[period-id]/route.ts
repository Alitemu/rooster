/**
 * Reminders Export Route
 *
 * POST /api/exports/reminders/[period-id] - Get reminder templates for staff
 * who haven't confirmed their preferences yet. Optional
 * ?days_before_deadline=N overrides how many days out to pretend it is;
 * defaults to the real number of days left before the period's actual
 * deadline. Either way, the tone (urgent/moderate/gentle) is decided by
 * where that number falls among the period's configured reminder
 * milestones (dienstrooster_reminder_schedule, see lib/reminderSchedule.ts)
 * rather than a fixed cutoff.
 *
 * The plaintext access token is never persisted (only its hash), so an
 * existing link can't be read back and put in the reminder - each person
 * in the batch gets a freshly issued one.
 *
 * That new link is issued ALONGSIDE whatever they already have, not
 * instead of it. This used to revoke their previous links first, which
 * meant generating reminders - even just to see who was still outstanding -
 * silently killed the link in everyone's original invitation email. A
 * personal link is only valid for its own period anyway, so letting people
 * keep using the first mail they received is worth more than retiring an
 * older token. Revoking is still possible (ingetrokken_op, honoured on
 * every request by lib/auth-context.ts) but is deliberately not something
 * an export does behind the planner's back.
 *
 * POST, not GET: it still mints credentials, and a GET that changes state
 * is reachable by anything that merely follows a URL with the planner's
 * cookie attached (a restored tab, a bookmark, an address-bar suggestion).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { generateAccessToken, hashToken } from '@/lib/auth';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { getActiveReminderMilestones, resolveReminderUrgency } from '@/lib/reminderSchedule';
import { resolveBaseUrl } from '@/lib/baseUrl';
import { checkRemindersAllowed } from '@/lib/reminderGate';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface ReminderTemplate {
  person_id: string;
  codenaam: string;
  personal_link: string;
  deadline: string;
  subject: string;
  body: string;
  /** The period's deadline as stored, which this text was written for. The send route refuses it once that changes. */
  deadline_bron: string;
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

export async function POST(req: NextRequest, props: { params: Promise<{ 'period-id': string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params['period-id'];

    // Get period info
    const periodStmt = db.prepare('SELECT naam, status, deadline, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?');
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

    // Checked before any link is issued: after the deadline the date in the
    // text would be wrong (see lib/reminderGate.ts).
    const gate = checkRemindersAllowed(period);
    if (!gate.allowed) {
      const response: ApiErrorResponse = { success: false, error: { code: gate.code, message: gate.message } };
      return NextResponse.json(response, { status: 409 });
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

    const insertStmt = db.prepare(`
      INSERT INTO dienstrooster_person_access_link
        (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?)
    `);

    const baseUrl = resolveBaseUrl(req);
    const now = new Date().toISOString();

    const daysBeforeDeadline = daysBeforeDeadlineFromOverride(
      req.nextUrl.searchParams.get('days_before_deadline'),
      period.deadline
    );
    const milestones = getActiveReminderMilestones(periodId);
    const urgency = resolveReminderUrgency(daysBeforeDeadline, milestones);

    const reminders: ReminderTemplate[] = outstanding.map((person) => {
      // Added to this person's links, not replacing them - their earlier
      // invitation link keeps working (see the module docstring).
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
          ? `Dit is je laatste herinnering. Je voorkeuren moeten uiterlijk ${deadline} binnen zijn.`
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

      return {
        person_id: person.person_id,
        codenaam: person.codenaam,
        personal_link: personalLink,
        deadline,
        subject,
        body,
        deadline_bron: period.deadline,
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
