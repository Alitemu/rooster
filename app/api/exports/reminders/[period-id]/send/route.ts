/**
 * POST /api/exports/reminders/[period-id]/send - mails the reminders the
 * planner prepared in the export dialog as a verzendlijst to the Power
 * Automate mailbox (lib/verzendlijstMail.ts).
 *
 * The texts come from the client because the planner may have edited them
 * there, with each person's own link (issued by POST ../reminders) already
 * substituted in. Every codenaam must belong to someone taking part in this
 * period: the flow looks it up in its own list, and an unknown one would
 * only fail there, out of sight.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { getInvitationPeriod } from '@/lib/periodInvitations';
import { sendVerzendlijst, verzendlijstMailConfigured } from '@/lib/verzendlijstMail';

const bodySchema = z.object({
  berichten: z
    .array(
      z.object({
        codenaam: z.string().trim().min(1).max(100),
        onderwerp: z.string().trim().min(1).max(300),
        tekst: z.string().trim().min(1).max(10_000),
      })
    )
    .min(1)
    .max(500),
});

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export async function POST(req: NextRequest, props: { params: Promise<{ 'period-id': string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    if (!requirePlannerAccess(getAuthContextFromRequest(req))) return unauthorizedResponse();

    const period = getInvitationPeriod(params['period-id']);
    if (!period) return fail(404, 'NOT_FOUND', 'Periode niet gevonden');
    if (!verzendlijstMailConfigured()) {
      return fail(409, 'NOT_CONFIGURED', 'Automatisch versturen is niet ingesteld op de server.');
    }

    const parsed = bodySchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) return fail(400, 'VALIDATION_ERROR', 'De berichten zijn onvolledig of te lang.');
    const { berichten } = parsed.data;

    const members = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT p.codenaam
             FROM dienstrooster_pool_membership pm
             JOIN dienstrooster_person p ON p.id = pm.person_id
             WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
          )
          .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ codenaam: string }>
      ).map((row) => row.codenaam)
    );
    const unknown = berichten.filter((b) => !members.has(b.codenaam)).map((b) => b.codenaam);
    if (unknown.length > 0) {
      return fail(400, 'UNKNOWN_PERSON', `Deze codenamen doen niet mee in deze periode: ${unknown.join(', ')}.`);
    }

    const result = await sendVerzendlijst(period.naam, berichten);
    if (!result.ok) return fail(502, 'MAIL_FAILED', result.message);
    return NextResponse.json({ success: true, data: { aantal: result.aantal } });
  } catch (error) {
    return internalErrorResponse('export-reminders-send', error);
  }
}
