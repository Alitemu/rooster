/**
 * Preferences Submission Route
 *
 * POST /api/person/[id]/preferences/submission - Confirm preferences
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
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
    const body = (await req.json()) as SubmissionRequest;

    const { period_id, parttime_confirmed } = body;

    if (!period_id) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_PERIOD_ID',
          message: 'Period ID is required',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (!parttime_confirmed) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PARTTIME_NOT_CONFIRMED',
          message: 'Must confirm part-time days before submitting',
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

    // Verify period exists
    const periodStmt = db.prepare(`SELECT id FROM dienstrooster_schedule_period WHERE id = ?`);
    if (!periodStmt.get(period_id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${period_id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Create or update submission record
    const checkStmt = db.prepare(`
      SELECT id FROM dienstrooster_submission
      WHERE person_id = ? AND period_id = ?
    `);

    const existing = checkStmt.get(id, period_id);
    const now = new Date().toISOString();

    if (existing) {
      const updateStmt = db.prepare(`
        UPDATE dienstrooster_submission
        SET status = 'BEVESTIGD', ingediend_op = ?, row_version = row_version + 1
        WHERE person_id = ? AND period_id = ?
      `);

      updateStmt.run(now, id, period_id);
    } else {
      const insertStmt = db.prepare(`
        INSERT INTO dienstrooster_submission
        (id, person_id, period_id, status, ingediend_op, row_version)
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
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'SUBMISSION_ERROR',
        message: `Failed to submit preferences: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}
