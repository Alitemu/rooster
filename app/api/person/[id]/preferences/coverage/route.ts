/**
 * Coverage Indicator Route
 *
 * GET /api/person/[id]/preferences/[period-id]/coverage - Per-day available people count
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface CoveragePerDay {
  datum: string;
  iso_week: number;
  total_in_pool: number;
  absoluut_blocked: number;
  liever_niet: number;
  available: number;
  message: string;
}

interface CoverageResponse {
  person_id: string;
  period_id: string;
  coverage_by_day: CoveragePerDay[];
}

/**
 * GET /api/person/[id]/preferences/[period-id]/coverage - Coverage per day
 *
 * Returns available person count for each day in period.
 * Shows how many people have blocked (ABSOLUUT) or soft-blocked (LIEVER_NIET)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; periodId?: string } }
): Promise<NextResponse> {
  try {
    const { id, periodId } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
    }

    if (!periodId) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_PERIOD_ID',
          message: 'Period ID is required',
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
    const periodStmt = db.prepare(`
      SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?
    `);
    const period = periodStmt.get(periodId) as any;
    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${periodId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Get pool size
    const poolSizeStmt = db.prepare(`
      SELECT COUNT(DISTINCT pm.person_id) as count
      FROM dienstrooster_pool_membership pm
      JOIN dienstrooster_schedule_period sp ON sp.pool_id = pm.pool_id
      WHERE sp.id = ?
        AND pm.geldig_vanaf <= sp.eind_datum
        AND pm.geldig_tot >= sp.start_datum
    `);

    const poolSizeRow = poolSizeStmt.get(periodId) as any;
    const poolSize = poolSizeRow?.count || 0;

    // Get all slots in period with blocking status
    const stmt = db.prepare(`
      SELECT
        s.datum,
        s.iso_week,
        s.teller,
        COUNT(DISTINCT CASE WHEN a.level = 'ABSOLUUT' THEN a.person_id END) as absoluut_count,
        COUNT(DISTINCT CASE WHEN a.level = 'LIEVER_NIET' THEN a.person_id END) as liever_niet_count
      FROM dienstrooster_shift_slot s
      LEFT JOIN dienstrooster_availability a ON a.slot_id = s.id
      WHERE s.period_id = ?
      GROUP BY s.datum, s.iso_week, s.teller
      ORDER BY s.datum, s.teller
    `);

    const slotRows = stmt.all(periodId) as any[];

    // Aggregate by day (across all counters for this day)
    const coverageMap = new Map<string, CoveragePerDay>();

    for (const row of slotRows) {
      const key = row.datum;

      if (!coverageMap.has(key)) {
        coverageMap.set(key, {
          datum: row.datum,
          iso_week: row.iso_week,
          total_in_pool: poolSize,
          absoluut_blocked: 0,
          liever_niet: 0,
          available: poolSize,
          message: '',
        });
      }

      const entry = coverageMap.get(key)!;
      entry.absoluut_blocked += row.absoluut_count;
      entry.liever_niet += row.liever_niet_count;
    }

    // Calculate available and message for each day
    for (const entry of coverageMap.values()) {
      entry.available = Math.max(0, entry.total_in_pool - entry.absoluut_blocked);

      if (entry.absoluut_blocked > 0 && entry.liever_niet > 0) {
        entry.message = `${entry.absoluut_blocked} blocked, ${entry.liever_niet} prefer not`;
      } else if (entry.absoluut_blocked > 0) {
        entry.message = `${entry.absoluut_blocked} blocked`;
      } else if (entry.liever_niet > 0) {
        entry.message = `${entry.liever_niet} prefer not`;
      } else {
        entry.message = 'All available';
      }
    }

    const coverage = Array.from(coverageMap.values());

    const response: ApiSuccessResponse<CoverageResponse> = {
      success: true,
      data: {
        person_id: id,
        period_id: periodId,
        coverage_by_day: coverage,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('preferences-coverage', error);
  }
}
