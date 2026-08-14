/**
 * Planner Dashboard Route
 *
 * GET /api/planner/period/[id]/dashboard - Complete dashboard data
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface SubmissionStats {
  not_started: number;
  in_progress: number;
  confirmed: number;
}

interface ImbalanceItem {
  person_id: string;
  codenaam: string;
  counter: string;
  delta: number;
  from_period: string;
}

interface DashboardData {
  period_id: string;
  period_name: string;
  status: string;
  submission_stats: SubmissionStats;
  large_imbalances: ImbalanceItem[];
  total_staff: number;
  staff_with_parttime: number;
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

    // Get period info
    const periodStmt = db.prepare('SELECT id, naam, status FROM dienstrooster_schedule_period WHERE id = ?');
    const period = periodStmt.get(periodId) as any;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Period not found',
        },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Get submission stats
    const statsStmt = db.prepare(`
      SELECT
        COUNT(CASE WHEN s.status IS NULL THEN 1 END) as not_started,
        COUNT(CASE WHEN s.status = 'BEZIG' THEN 1 END) as in_progress,
        COUNT(CASE WHEN s.status = 'BEVESTIGD' THEN 1 END) as confirmed
      FROM dienstrooster_person p
      LEFT JOIN dienstrooster_submission s ON p.id = s.person_id AND s.schedule_period_id = ?
      WHERE p.id IN (
        SELECT DISTINCT person_id
        FROM dienstrooster_pool_membership
        WHERE pool_id = (SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?)
      )
    `);

    const stats = statsStmt.get(periodId, periodId) as any;

    // Get large imbalances (>= 2)
    const imbalancesStmt = db.prepare(`
      SELECT
        p.id as person_id,
        p.codenaam,
        le.teller as counter,
        SUM(le.delta) as delta,
        sp.naam as from_period
      FROM dienstrooster_ledger_entry le
      JOIN dienstrooster_person p ON p.id = le.person_id
      JOIN dienstrooster_schedule_period sp ON le.geldt_voor_periode_id = sp.id
      WHERE le.geldt_voor_periode_id = ?
      GROUP BY p.id, le.teller
      HAVING ABS(delta) >= 2
      ORDER BY ABS(delta) DESC
    `);

    const imbalances = imbalancesStmt.all(periodId) as ImbalanceItem[];

    // Get staff with parttime patterns
    const parttimeStmt = db.prepare(`
      SELECT COUNT(DISTINCT p.id) as count
      FROM dienstrooster_person p
      WHERE p.id IN (
        SELECT DISTINCT person_id FROM dienstrooster_parttime_pattern
      )
      AND p.id IN (
        SELECT DISTINCT person_id
        FROM dienstrooster_pool_membership
        WHERE pool_id = (SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?)
      )
    `);

    const parttimeCount = parttimeStmt.get(periodId) as any;

    // Get total staff
    const totalStaffStmt = db.prepare(`
      SELECT COUNT(DISTINCT person_id) as count
      FROM dienstrooster_pool_membership
      WHERE pool_id = (SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?)
    `);

    const totalStaff = totalStaffStmt.get(periodId) as any;

    const response: ApiSuccessResponse<DashboardData> = {
      success: true,
      data: {
        period_id: period.id,
        period_name: period.naam,
        status: period.status,
        submission_stats: {
          not_started: stats.not_started || 0,
          in_progress: stats.in_progress || 0,
          confirmed: stats.confirmed || 0,
        },
        large_imbalances: imbalances,
        total_staff: totalStaff?.count || 0,
        staff_with_parttime: parttimeCount?.count || 0,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('planner-dashboard', error);
  }
}
