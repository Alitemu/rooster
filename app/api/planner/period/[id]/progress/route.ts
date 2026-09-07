/**
 * Period Progress Route
 *
 * GET /api/planner/period/[id]/progress - Per-person submission status
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse } from '@/types';

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
  _req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(_req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

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
         AND slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)
         AND blocking_level = 'ABSOLUUT') as blocked_days_count,
        CASE
          WHEN (
            SELECT COUNT(*) FROM dienstrooster_absence a
            JOIN dienstrooster_schedule_period sp ON sp.id = ?
            WHERE a.person_id = p.id AND a.van_datum <= sp.eind_datum AND a.tot_datum >= sp.start_datum
          ) > 0
          THEN 1
          ELSE 0
        END as has_absences
      FROM dienstrooster_person p
      LEFT JOIN dienstrooster_submission s ON p.id = s.person_id AND s.schedule_period_id = ?
      WHERE p.id IN (
        SELECT DISTINCT pm.person_id
        FROM dienstrooster_pool_membership pm
        JOIN dienstrooster_schedule_period sp2 ON sp2.id = ?
        WHERE pm.pool_id = sp2.pool_id
          AND pm.geldig_vanaf <= sp2.eind_datum AND pm.geldig_tot >= sp2.start_datum
      )
      ORDER BY p.codenaam ASC
    `);

    const progress = progressStmt.all(periodId, periodId, periodId, periodId) as PersonProgress[];

    const response: ApiSuccessResponse<PersonProgress[]> = {
      success: true,
      data: progress,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('planner-progress', error);
  }
}
