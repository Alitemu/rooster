/**
 * POST /api/planner/period/[id]/unpublish
 *
 * Withdraw a published roster back to GEGENEREERD, so a planner can
 * correct a mistaken publish (or one they simply want to revise) without
 * that being permanent.
 *
 * Before this route existed there was no way back from GEPUBLICEERD at
 * all - publishing a roster too early, or with something a planner only
 * noticed afterwards, was final.
 *
 * Deliberately symmetric with publish/route.ts:
 *   - Same guard shape (status check, transaction, audit log, participant
 *     notifications).
 *   - Reuses cleanupPhase3WorkflowData's exact status reset
 *     (`status = 'GEGENEREERD', gepubliceerd_op = NULL,
 *     gepubliceerd_door_person_id = NULL`) - the same reset a test
 *     teardown already relied on being the correct "undo publish" shape.
 *
 * What this does NOT do:
 *   - Delete the assignments. Withdrawing is not discarding the roster;
 *     the planner can keep editing it (manual-assign, regenerate) and
 *     publish again later.
 *   - Delete the "your roster is published" notifications already sent.
 *     Those are a historical record of what happened and stay exactly
 *     that; a new notification tells people the roster was withdrawn
 *     instead.
 *   - Touch pending swap requests. checkSwapAllowed already refuses to
 *     act on one outside GEPUBLICEERD, and the approve route separately
 *     re-checks that the assignments it names still match what the
 *     request was actually about - so a stale request from before the
 *     withdrawal can't silently apply to a roster that has since changed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { dateToISO } from '@/lib/holidays';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { insertNotification } from '@/lib/notifications';

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const actorId = auth!.userId;

    const periodId = params.id;
    const now = dateToISO(new Date());

    const period = db
      .prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as any;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Periode niet gevonden' },
        { status: 404 }
      );
    }

    if (period.status !== 'GEPUBLICEERD') {
      return NextResponse.json(
        { success: false, error: `Alleen een gepubliceerde periode kan ingetrokken worden (huidige status: ${period.status})` },
        { status: 400 }
      );
    }

    const people = db
      .prepare(
        `SELECT DISTINCT pm.person_id, p.codenaam FROM dienstrooster_pool_membership pm
         JOIN dienstrooster_person p ON p.id = pm.person_id
         WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
      )
      .all(period.pool_id, period.eind_datum, period.start_datum) as any[];

    const unpublishTx = db.transaction(() => {
      db.prepare(
        `UPDATE dienstrooster_schedule_period
         SET status = 'GEGENEREERD', gepubliceerd_op = NULL, gepubliceerd_door_person_id = NULL,
             row_version = row_version + 1
         WHERE id = ?`
      ).run(periodId);

      for (const p of people) {
        insertNotification({
          personId: p.person_id,
          periodId,
          type: 'PUBLICATIE_BERICHT',
          onderwerp: `${period.naam}: publicatie ingetrokken`,
          inhoud:
            `Het gepubliceerde rooster voor ${period.naam} is teruggetrokken door de roosteraar. ` +
            `Beschouw je eerder getoonde diensten voorlopig niet meer als definitief - ` +
            `je hoort opnieuw van ons zodra er een nieuwe versie gepubliceerd is.`,
        });
      }

      db.prepare(
        `INSERT INTO dienstrooster_audit_log
         (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        actorId,
        'schedule_period',
        periodId,
        'UPDATE',
        JSON.stringify({ status: 'GEPUBLICEERD' }),
        JSON.stringify({ status: 'GEGENEREERD', wijziging: 'publicatie_ingetrokken', notifications_sent: people.length }),
        now
      );

      return people.length;
    });

    const notificationsCreated = unpublishTx();

    return NextResponse.json({
      success: true,
      data: {
        period: { id: periodId, status: 'GEGENEREERD' },
        notifications_sent: notificationsCreated,
      },
    });
  } catch (error) {
    return internalErrorResponse('unpublish', error);
  }
}
