/**
 * Period Progress Route
 *
 * GET /api/planner/period/[id]/progress - Per-person submission status
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface PersonProgress {
  person_id: string;
  codenaam: string;
  submission_status: string | null;
  submitted_at: string | null;
  has_parttime_patterns: boolean;
  blocked_days_count: number;
  has_absences: boolean;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const periodId = params.id;

    const progressStmt = db.prepare(`
      SELECT
        p.id as person_id,
        p.codenaam,
        s.status as submission_status,
        s.ingediend_op as submitted_at,
        CASE
          WHEN (SELECT COUNT(*) FROM dienstrooster_parttime_pattern WHERE person_id = p.id) > 0
          THEN 1
          ELSE 0
        END as has_parttime_patterns,
        (SELECT COUNT(*) FROM dienstrooster_availability
         WHERE person_id = p.id
         AND slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE schedule_period_id = ?)
         AND blocking_level = 'ABSOLUUT') as blocked_days_count,
        CASE
          WHEN (SELECT COUNT(*) FROM dienstrooster_absence WHERE person_id = p.id) > 0
          THEN 1
          ELSE 0
        END as has_absences
      FROM dienstrooster_person p
      LEFT JOIN dienstrooster_submission s ON p.id = s.person_id AND s.schedule_period_id = ?
      WHERE p.id IN (
        SELECT DISTINCT person_id
        FROM dienstrooster_pool_membership
        WHERE pool_id = (SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?)
      )
      ORDER BY p.codenaam ASC
    `);

    const progress = progressStmt.all(periodId, periodId, periodId) as PersonProgress[];

    const response: ApiSuccessResponse<PersonProgress[]> = {
      success: true,
      data: progress,
    };

    return NextResponse.json(response);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'FETCH_ERROR',
        message: `Failed to fetch progress: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}
