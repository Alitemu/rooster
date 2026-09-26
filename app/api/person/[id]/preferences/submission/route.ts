/**
 * Preferences Submission Route
 *
 * POST /api/person/[id]/preferences/submission - Confirm preferences
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { isPeriodVisibleToPerson } from '@/lib/periodAccess';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writePreferencesBackup } from '@/lib/preferencesBackup';
import { checkPeriodAcceptsInput } from '@/lib/periodInputGate';
import { getParttimeCheck } from '@/lib/submissionStatus';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface SubmissionRequest {
  period_id: string;
}

interface SubmissionResponse {
  person_id: string;
  period_id: string;
  status: string;
  submitted_at: string;
}

/**
 * POST /api/person/[id]/preferences/submission - Submit preferences
 *
 * Marks preferences as confirmed for the period. Requires the "Deeltijd"
 * step's check to be on record (submission.deeltijd_gecontroleerd_op,
 * lib/submissionStatus.ts) - checked here, not taken from the client.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const { id } = params;

    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;

    const body = (await parseJsonBody(req)) as SubmissionRequest;

    const { period_id } = body;

    if (!period_id) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_PERIOD_ID',
          message: 'Periode-ID is verplicht',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Persoon ${id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Verify period exists and still accepts submissions
    const periodStmt = db.prepare(
      `SELECT id, status, deadline, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?`
    );
    const period = periodStmt.get(period_id) as
      | { id: string; status: string; deadline: string; pool_id: string; start_datum: string; eind_datum: string }
      | undefined;
    // Same scoping as the slot route: submitting for a period you have
    // nothing to do with (another pool's) is treated as not existing.
    if (!period || (!requirePlannerAccess(auth) && !isPeriodVisibleToPerson(id, period))) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${period_id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const gate = checkPeriodAcceptsInput(period);
    if (!gate.allowed) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: gate.code!, message: gate.message! },
      };
      return NextResponse.json(response, { status: 403 });
    }

    if (!getParttimeCheck(id, period_id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PARTTIME_NOT_CONFIRMED',
          message: 'Bevestig eerst bij de stap Deeltijd dat je deeltijddagen en afwezigheid kloppen.',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Create or update submission record
    const checkStmt = db.prepare(`
      SELECT id FROM dienstrooster_submission
      WHERE person_id = ? AND schedule_period_id = ?
    `);

    const existing = checkStmt.get(id, period_id);
    const now = new Date().toISOString();

    if (existing) {
      const updateStmt = db.prepare(`
        UPDATE dienstrooster_submission
        SET status = 'BEVESTIGD', ingediend_op = ?, row_version = row_version + 1
        WHERE person_id = ? AND schedule_period_id = ?
      `);

      updateStmt.run(now, id, period_id);
    } else {
      const insertStmt = db.prepare(`
        INSERT INTO dienstrooster_submission
        (id, person_id, schedule_period_id, status, ingediend_op, row_version, aangemaakt_op)
        VALUES (?, ?, ?, 'BEVESTIGD', ?, 1, ?)
      `);

      insertStmt.run(crypto.randomUUID(), id, period_id, now, now);
    }

    try {
      writePreferencesBackup(id, period_id);
    } catch (backupError) {
      console.error('preferences-backup-write-failed', backupError);
    }

    const response: ApiSuccessResponse<SubmissionResponse> = {
      success: true,
      data: {
        person_id: id,
        period_id,
        status: 'BEVESTIGD',
        submitted_at: now,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('preferences-submission', error);
  }
}
