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
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { runPublicationCheck } from '@/lib/publicationCheck';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const publishedByPersonId = auth!.userId;

    const periodId = params.id;
    const now = dateToISO(new Date());

    // Verify period exists
    const period = db
      .prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as any;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Period not found' },
        { status: 404 }
      );
    }

    if (period.status !== 'GEGENEREERD') {
      return NextResponse.json(
        { success: false, error: `Cannot publish period in ${period.status} status` },
        { status: 400 }
      );
    }

    // Enforce the same validation the planner saw, rather than assuming the
    // dialog ran it. Publishing freezes the roster and tells every pool
    // member these are their shifts, so a direct POST must not be able to
    // ship one with unfilled slots or ABSOLUUT violations - which it could:
    // the disabled button in the UI was the only thing standing in the way.
    const check = runPublicationCheck(period);
    if (!check.valid) {
      return NextResponse.json(
        {
          success: false,
          error: `Roster is not ready to publish: ${check.issues.join('; ')}`,
          data: { issues: check.issues, checks: check.checks },
        },
        { status: 400 }
      );
    }

    // Get all people whose membership window covers this period
    // (membership windows are open-ended, not scoped to one period)
    const people = db
      .prepare(
        `SELECT DISTINCT person_id FROM dienstrooster_pool_membership
         WHERE pool_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
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

      const insertNotification = db.prepare(
        `INSERT INTO dienstrooster_notification
         (id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const p of people) {
        insertNotification.run(
          uuid(),
          p.person_id,
          periodId,
          'PUBLICATIE_BERICHT',
          'Roster published',
          `Your roster for ${period.naam} is now available. Open your link to see your shifts.`,
          0,
          now
        );
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
        JSON.stringify({ status: 'GEPUBLICEERD', notifications_sent: people.length }),
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
