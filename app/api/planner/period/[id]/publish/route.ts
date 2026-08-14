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

    // Get all people in this period
    const people = db
      .prepare(
        `SELECT DISTINCT person_id FROM dienstrooster_pool_membership
         WHERE pool_id = ? AND geldig_vanaf = ? AND geldig_tot = ?`
      )
      .all(period.pool_id, period.start_datum, period.eind_datum) as any[];

    let notificationsCreated = 0;

    // Update period status
    db.prepare(
      `UPDATE dienstrooster_schedule_period
       SET status = ?, gepubliceerd_op = ?, gepubliceerd_door_person_id = ?, row_version = row_version + 1
       WHERE id = ?`
    ).run('GEPUBLICEERD', now, publishedByPersonId, periodId);

    // Create notifications for each person
    for (const p of people) {
      const notifId = uuid();
      db.prepare(
        `INSERT INTO dienstrooster_notification
         (id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        notifId,
        p.person_id,
        periodId,
        'PUBLICATIE_BERICHT',
        'Roster published',
        `Your roster for ${period.naam} is now available. Open your link to see your shifts.`,
        false,
        now
      );
      notificationsCreated++;
    }

    // Log audit entry
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
      JSON.stringify({ status: 'GEPUBLICEERD', notifications_sent: notificationsCreated }),
      now
    );

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
