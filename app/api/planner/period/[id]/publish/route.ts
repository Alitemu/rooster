/**
 * POST /api/planner/period/[id]/publish
 *
 * Mark period as PUBLISHED and send notifications to all staff.
 * Prerequisites: publication-check must pass.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { dateToISO } from '@/lib/holidays';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { runPublicationCheck } from '@/lib/publicationCheck';
import { renderNotificationTemplate, insertNotification } from '@/lib/notifications';

interface PublishRequest {
  /**
   * Required when runPublicationCheck() reports warnings (an ABSOLUUT or
   * window-rule override a planner deliberately made via manual-assign).
   * Absent or false, publish stops and hands back the warnings for the
   * confirmation screen instead of shipping the roster.
   */
  confirmOverrides?: boolean;
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const publishedByPersonId = auth!.userId;

    const periodId = params.id;
    const now = dateToISO(new Date());
    const body = await parseJsonBody<PublishRequest>(request);

    // Verify period exists
    const period = db
      .prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as any;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Periode niet gevonden' },
        { status: 404 }
      );
    }

    if (period.status !== 'GEGENEREERD') {
      return NextResponse.json(
        { success: false, error: `Periode kan niet gepubliceerd worden vanuit status ${period.status}` },
        { status: 400 }
      );
    }

    // Enforce the same validation the planner saw, rather than assuming the
    // dialog ran it. Publishing freezes the roster and tells every pool
    // member these are their shifts, so a direct POST must not be able to
    // ship one with unfilled slots or a band violation - which it could:
    // the disabled button in the UI was the only thing standing in the way.
    const check = runPublicationCheck(period);
    if (!check.valid) {
      return NextResponse.json(
        {
          success: false,
          error: `Rooster is nog niet klaar om te publiceren: ${check.issues.join('; ')}`,
          data: { issues: check.issues, checks: check.checks },
        },
        { status: 400 }
      );
    }

    // check.warnings are deliberate overrides (see lib/publicationCheck.ts) -
    // real, worth a planner looking at one more time before this goes out,
    // but not something publish should refuse. Without confirmOverrides,
    // stop and hand back exactly what would need confirming; the dialog
    // shows this and re-POSTs with confirmOverrides once the planner has
    // seen it. A direct POST that skips the dialog entirely gets the same
    // stop, not a silent publish - matching how check.issues was already
    // enforced above.
    if (check.requiresConfirmation && body.confirmOverrides !== true) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'CONFIRMATION_REQUIRED',
            message: `Dit rooster bevat bewuste uitzonderingen: ${check.warnings.join('; ')}`,
          },
          data: { warnings: check.warnings, checks: check.checks },
        },
        { status: 409 }
      );
    }

    // Get all people whose membership window covers this period
    // (membership windows are open-ended, not scoped to one period)
    const people = db
      .prepare(
        `SELECT DISTINCT pm.person_id, p.codenaam FROM dienstrooster_pool_membership pm
         JOIN dienstrooster_person p ON p.id = pm.person_id
         WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
      )
      .all(period.pool_id, period.eind_datum, period.start_datum) as any[];

    // Publishing is: freeze the status change, notify everyone, and audit
    // it - all or nothing. A partial failure part-way through (e.g. one bad
    // insert) must not leave the period marked published with nobody
    // actually notified.
    const publishTx = db.transaction(() => {
      db.prepare(
        `UPDATE dienstrooster_schedule_period
         SET status = ?, gepubliceerd_op = ?, gepubliceerd_door_person_id = ?, row_version = row_version + 1
         WHERE id = ?`
      ).run('GEPUBLICEERD', now, publishedByPersonId, periodId);

      for (const p of people) {
        const rendered = renderNotificationTemplate('SCHEDULE_PUBLISHED', {
          codenaam: p.codenaam,
          periode: period.naam,
          link: '',
        });
        insertNotification({
          personId: p.person_id,
          periodId,
          type: 'PUBLICATIE_BERICHT',
          onderwerp: rendered?.onderwerp || `${period.naam}: het rooster is gepubliceerd`,
          inhoud:
            rendered?.inhoud ||
            `Het rooster voor ${period.naam} is gepubliceerd. Open je eigen link om je diensten te bekijken.`,
        });
      }

      db.prepare(
        `INSERT INTO dienstrooster_audit_log
         (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        publishedByPersonId,
        'schedule_period',
        periodId,
        'PUBLISH',
        JSON.stringify({ status: 'GEGENEREERD' }),
        JSON.stringify({
          status: 'GEPUBLICEERD',
          notifications_sent: people.length,
          // Empty when there was nothing to confirm - keeps the common
          // case's audit entry uncluttered rather than always carrying an
          // empty array.
          ...(check.warnings.length > 0 ? { overrides_confirmed: check.warnings } : {}),
        }),
        now
      );

      return people.length;
    });

    const notificationsCreated = publishTx();

    return NextResponse.json({
      success: true,
      data: {
        period: {
          id: periodId,
          status: 'GEPUBLICEERD',
          gepubliceerd_op: now,
        },
        notifications_sent: notificationsCreated,
      },
    });
  } catch (error) {
    return internalErrorResponse('publish', error);
  }
}
