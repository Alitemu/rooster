/**
 * POST /api/planner/period/[id]/remind - sends a reminder straight away,
 * with the standard text, from the "Status voorkeuren" table: to one
 * person (`person_id`), or without it to everyone taking part who hasn't
 * handed in yet.
 *
 * The same message the automatic reminders use (lib/autoReminders.ts
 * reminderBericht: its own text for someone who hasn't started and for
 * someone who hasn't handed in), each with a freshly issued personal link,
 * as one verzendlijst to the flow. Unlike the automatic ones this does not
 * skip anyone reminded in the last day: the planner pressed the button on
 * purpose. It is logged the same way, so the automatic reminder then
 * leaves these people alone for a day.
 *
 * Someone who has handed in (BEVESTIGD) never gets one: a single request
 * for them is refused, and "everyone" leaves them out.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { getInvitationPeriod, issuePersonLink, rememberBaseUrl } from '@/lib/periodInvitations';
import { resolveBaseUrl } from '@/lib/baseUrl';
import { buildVerzendlijst } from '@/lib/verzendlijst';
import { checkRemindersAllowed } from '@/lib/reminderGate';
import { logRemindersSent, reminderBericht, type ReminderGroep } from '@/lib/autoReminders';
import { sendVerzendlijst, verzendlijstMailConfigured } from '@/lib/verzendlijstMail';

const bodySchema = z.object({ person_id: z.string().min(1).optional() });

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    if (!requirePlannerAccess(getAuthContextFromRequest(req))) return unauthorizedResponse();

    const period = getInvitationPeriod(params.id);
    if (!period) return fail(404, 'NOT_FOUND', 'Periode niet gevonden');

    const parsed = bodySchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) return fail(400, 'VALIDATION_ERROR', 'Ongeldig verzoek.');
    const personId = parsed.data.person_id;

    const gate = checkRemindersAllowed(period);
    if (!gate.allowed) return fail(409, gate.code, gate.message);
    if (!verzendlijstMailConfigured()) {
      return fail(409, 'NOT_CONFIGURED', 'Automatisch versturen is nog niet ingesteld. Dat doe je bij Mailinstellingen.');
    }

    // Everyone taking part, with where they are.
    const members = db
      .prepare(
        `SELECT DISTINCT p.id AS person_id, p.codenaam, s.status
         FROM dienstrooster_pool_membership pm
         JOIN dienstrooster_person p ON p.id = pm.person_id
         LEFT JOIN dienstrooster_submission s ON s.person_id = p.id AND s.schedule_period_id = ?
         WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1
         ORDER BY p.codenaam`
      )
      .all(period.id, period.pool_id, period.eind_datum, period.start_datum) as Array<{
      person_id: string;
      codenaam: string;
      status: string | null;
    }>;

    let ontvangers = members.filter((m) => m.status !== 'BEVESTIGD');
    if (personId) {
      const member = members.find((m) => m.person_id === personId);
      if (!member) return fail(404, 'PERSON_NOT_FOUND', 'Deze persoon doet niet mee in deze periode.');
      if (member.status === 'BEVESTIGD') {
        return fail(409, 'ALREADY_SUBMITTED', `${member.codenaam} heeft de voorkeuren al ingediend.`);
      }
      ontvangers = [member];
    }
    if (ontvangers.length === 0) {
      return fail(409, 'NOBODY_LEFT', 'Iedereen heeft de voorkeuren al ingediend.');
    }

    const baseUrl = resolveBaseUrl(req);
    rememberBaseUrl(period.id, baseUrl);
    const metGroep = ontvangers.map((o) => ({
      ...o,
      groep: (o.status === 'BEZIG' ? 'BEZIG' : 'NIET_BEGONNEN') as ReminderGroep,
    }));
    const berichten = metGroep.map((o) =>
      reminderBericht(period, o, issuePersonLink(o.person_id, period.id, baseUrl), false)
    );
    const bezig = metGroep.filter((o) => o.groep === 'BEZIG').length;

    const now = new Date();
    const result = await sendVerzendlijst(
      buildVerzendlijst(
        {
          soort: 'HERINNERING',
          automatisch: false,
          periode: period.naam,
          deadline: period.deadline,
          groepen: { nog_niets_ingevuld: metGroep.length - bezig, nog_niet_ingediend: bezig },
        },
        berichten,
        now
      )
    );
    if (!result.ok) return fail(502, 'MAIL_FAILED', result.message);

    logRemindersSent(
      ontvangers.map((o) => o.person_id),
      period.id,
      false,
      now
    );
    return NextResponse.json({ success: true, data: { aantal: result.aantal } });
  } catch (error) {
    return internalErrorResponse('planner-remind', error);
  }
}
