/**
 * Preferences Submission Route
 *
 * POST /api/person/[id]/preferences/submission - Confirm preferences
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface SubmissionRequest {
  period_id: string;
  parttime_confirmed: boolean; // Must be true to submit
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
 * Marks preferences as confirmed for the period.
 * Requires parttime_confirmed flag (user must verify part-time days)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
    }

    const body = (await parseJsonBody(req)) as SubmissionRequest;

    const { period_id, parttime_confirmed } = body;

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

    if (!parttime_confirmed) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PARTTIME_NOT_CONFIRMED',
          message: 'Bevestig eerst je deeltijddagen voordat je indient',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Verify period exists and still accepts submissions
    const periodStmt = db.prepare(`SELECT id, status FROM dienstrooster_schedule_period WHERE id = ?`);
    const period = periodStmt.get(period_id) as { id: string; status: string } | undefined;
    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${period_id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    if (period.status !== 'OPEN') {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PERIOD_NOT_OPEN',
          message: `Preferences are read-only once the period is ${period.status}`,
        },
      };
      return NextResponse.json(response, { status: 403 });
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
        (id, person_id, schedule_period_id, status, ingediend_op, row_version)
        VALUES (?, ?, ?, 'BEVESTIGD', ?, 1)
      `);

      insertStmt.run(crypto.randomUUID(), id, period_id, now);
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
