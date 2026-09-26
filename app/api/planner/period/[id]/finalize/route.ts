/**
 * POST /api/planner/period/[id]/finalize
 *
 * Makes a voorlopig published roster definitief (lib/publication.ts). Only
 * ever by hand: the planner decides nobody objected, usually about two
 * weeks after the voorlopige publication. Corrections the planner made in
 * between are part of the roster by then; the publication check runs again
 * on what it has become, with the same rule as publishing: unfilled slots
 * stop it, warnings need `confirmOverrides: true`.
 *
 * Everyone taking part gets an in-app notice and, once mail is set up,
 * their final shifts by mail with what changed for them since the
 * voorlopige version. The mail goes out after the commit and its outcome is
 * reported back; a failed mail does not undo the step.
 */

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { runPublicationCheck } from '@/lib/publicationCheck';
import { insertNotification } from '@/lib/notifications';
import { publicationRecipients, readVoorlopigSnapshot, sendRosterMail } from '@/lib/publication';
import { resolveBaseUrl } from '@/lib/baseUrl';
import { rememberBaseUrl } from '@/lib/periodInvitations';

function fail(status: number, code: string, message: string, data?: unknown): NextResponse {
  return NextResponse.json({ success: false, error: { code, message }, ...(data ? { data } : {}) }, { status });
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id: periodId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const actorId = auth!.userId;
    const body = await parseJsonBody<{ confirmOverrides?: boolean }>(request);

    const period = db.prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as any;
    if (!period) return fail(404, 'NOT_FOUND', 'Periode niet gevonden');
    if (period.status !== 'GEPUBLICEERD') {
      return fail(409, 'NOT_PUBLISHED', 'Alleen een gepubliceerd rooster kan definitief gemaakt worden.');
    }
    if (period.definitief_op) return fail(409, 'ALREADY_FINAL', 'Dit rooster is al definitief.');

    const check = runPublicationCheck(period);
    if (!check.valid) {
      return fail(400, 'NOT_READY', `Het rooster is nog niet compleet: ${check.issues.join('; ')}`, {
        issues: check.issues,
        checks: check.checks,
      });
    }
    if (check.requiresConfirmation && body.confirmOverrides !== true) {
      return fail(409, 'CONFIRMATION_REQUIRED', `Dit rooster bevat bewuste uitzonderingen: ${check.warnings.join('; ')}`, {
        warnings: check.warnings,
        checks: check.checks,
      });
    }

    const now = new Date().toISOString();
    const people = publicationRecipients(period);
    db.transaction(() => {
      const updated = db
        .prepare(
          `UPDATE dienstrooster_schedule_period
           SET definitief_op = ?, definitief_door_person_id = ?, row_version = row_version + 1
           WHERE id = ? AND status = 'GEPUBLICEERD' AND definitief_op IS NULL`
        )
        .run(now, actorId, periodId);
      if (updated.changes === 0) throw new Error('finalize: period changed underneath');

      for (const p of people) {
        insertNotification({
          personId: p.person_id,
          periodId,
          type: 'PUBLICATIE_BERICHT',
          onderwerp: `${period.naam}: het rooster is definitief`,
          inhoud: `Het rooster voor ${period.naam} is nu definitief. Je ziet je diensten in je eigen overzicht. Wil je later toch ruilen? Dat kan daar ook.`,
        });
      }

      db.prepare(
        `INSERT INTO dienstrooster_audit_log
         (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
         VALUES (?, ?, 'schedule_period', ?, 'UPDATE', ?, ?, ?)`
      ).run(
        uuid(),
        actorId,
        periodId,
        JSON.stringify({ publicatie: 'voorlopig' }),
        JSON.stringify({
          publicatie: 'definitief',
          notifications_sent: people.length,
          ...(check.warnings.length > 0 ? { overrides_confirmed: check.warnings } : {}),
        }),
        now
      );
    })();

    const baseUrl = resolveBaseUrl(request);
    rememberBaseUrl(periodId, baseUrl);
    const mail = await sendRosterMail(
      'ROOSTER_DEFINITIEF',
      period,
      baseUrl,
      readVoorlopigSnapshot(period.voorlopig_rooster_json)
    );

    return NextResponse.json({
      success: true,
      data: { period: { id: periodId, status: 'GEPUBLICEERD', definitief_op: now }, notifications_sent: people.length, mail },
    });
  } catch (error) {
    return internalErrorResponse('finalize', error);
  }
}
