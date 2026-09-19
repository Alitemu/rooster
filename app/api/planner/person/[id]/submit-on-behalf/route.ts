/**
 * Submit Preferences On Behalf Route
 *
 * POST /api/planner/person/[id]/submit-on-behalf - Submit for another person with logging
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface SubmitRequest {
  period_id: string;
  reason?: string;
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const submittedByPersonId = auth!.userId;

    const personId = params.id;
    const body = await parseJsonBody<SubmitRequest>(req);

    if (!body.period_id) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_FIELDS',
          message: 'Verplicht veld ontbreekt: period_id',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Both checked before anything else: the preference count below
    // returns 0 for a person who does not exist and for a period that does
    // not exist, so every mistyped id used to come back as "Deze persoon
    // heeft nog geen voorkeuren ingediend" - which sends a planner looking
    // at the wrong problem entirely.
    if (!db.prepare('SELECT 1 FROM dienstrooster_person WHERE id = ?').get(personId)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Persoon ${personId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // `verwijderd_op IS NULL`: a period in the trash is on its way out, so
    // recording a confirmed submission against it is recording something
    // that is about to disappear.
    if (
      !db
        .prepare('SELECT 1 FROM dienstrooster_schedule_period WHERE id = ? AND verwijderd_op IS NULL')
        .get(body.period_id)
    ) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${body.period_id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Check if person has blocking preferences
    const slotStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM dienstrooster_availability
      WHERE person_id = ?
      AND slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)
      AND blocking_level IS NOT NULL
    `);

    const slotCount = slotStmt.get(personId, body.period_id) as any;

    if (!slotCount || slotCount.count === 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'NO_PREFERENCES',
          message: 'Deze persoon heeft nog geen voorkeuren ingediend. Kan geen lege voorkeuren indienen.',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Check if already submitted
    const existingStmt = db.prepare(
      'SELECT status FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?'
    );

    const existing = existingStmt.get(personId, body.period_id) as any;

    if (existing && existing.status === 'BEVESTIGD') {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'ALREADY_SUBMITTED',
          message: 'Deze persoon heeft al voorkeuren ingediend',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    const now = new Date().toISOString();

    const details = JSON.stringify({
      person_id: personId,
      period_id: body.period_id,
      reason: body.reason || 'Submitted on behalf by planner',
      submitted_at: now,
    });

    // The submission and its audit row are one change. This is a planner
    // confirming something in someone else's name, so the audit row is the
    // only record that it was not that person who did it - a crash between
    // the two writes would leave a confirmed submission that looks exactly
    // like one they made themselves.
    const submitOnBehalf = db.transaction(() => {
      if (existing) {
        db.prepare(
          `UPDATE dienstrooster_submission
           SET status = 'BEVESTIGD', ingediend_op = ?, row_version = row_version + 1
           WHERE person_id = ? AND schedule_period_id = ?`
        ).run(now, personId, body.period_id);
      } else {
        db.prepare(
          `INSERT INTO dienstrooster_submission
             (id, person_id, schedule_period_id, status, ingediend_op, row_version)
           VALUES (?, ?, ?, 'BEVESTIGD', ?, 1)`
        ).run(crypto.randomUUID(), personId, body.period_id, now);
      }

      db.prepare(
        `INSERT INTO dienstrooster_audit_log
           (id, actor_id, entiteit, entiteit_id, actie, nieuw_json, tijdstip)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(crypto.randomUUID(), submittedByPersonId, 'submission', personId, 'CREATE', details, now);
    });
    submitOnBehalf();

    const response: ApiSuccessResponse<{ success: true; submitted_at: string }> = {
      success: true,
      data: {
        success: true,
        submitted_at: now,
      },
    };

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    return internalErrorResponse('submit-on-behalf', error);
  }
}
