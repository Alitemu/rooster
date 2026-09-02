/**
 * GET /api/person/[id]/preferences/[periodId]/coverage - Per-day available people count
 *
 * Returns available person count for each day in period.
 * Shows how many people have blocked (ABSOLUUT) or soft-blocked (LIEVER_NIET)
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
  voorkeur: number;
  available: number;
  message: string;
}

interface CoverageResponse {
  person_id: string;
  period_id: string;
  coverage_by_day: CoveragePerDay[];
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; periodId: string } }
): Promise<NextResponse> {
  try {
    const { id, periodId } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
    }

    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

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
        st.teller,
        COUNT(DISTINCT CASE WHEN a.blocking_level = 'ABSOLUUT' THEN a.person_id END) as absoluut_count,
        COUNT(DISTINCT CASE WHEN a.blocking_level = 'LIEVER_NIET' THEN a.person_id END) as liever_niet_count,
        COUNT(DISTINCT CASE WHEN a.blocking_level = 'VOORKEUR' THEN a.person_id END) as voorkeur_count
      FROM dienstrooster_shift_slot s
      JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
      LEFT JOIN dienstrooster_availability a ON a.slot_id = s.id
      WHERE s.period_id = ?
      GROUP BY s.datum, s.iso_week, st.teller
      ORDER BY s.datum, st.teller
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
          voorkeur: 0,
          available: poolSize,
          message: '',
        });
      }

      const entry = coverageMap.get(key)!;
      entry.absoluut_blocked += row.absoluut_count;
      entry.liever_niet += row.liever_niet_count;
      entry.voorkeur += row.voorkeur_count;
    }

    // Calculate available and message for each day
    for (const entry of coverageMap.values()) {
      entry.available = Math.max(0, entry.total_in_pool - entry.absoluut_blocked);

      const parts: string[] = [];
      if (entry.absoluut_blocked > 0) parts.push(`${entry.absoluut_blocked} geblokkeerd`);
      if (entry.liever_niet > 0) parts.push(`${entry.liever_niet} liever niet`);
      if (entry.voorkeur > 0) parts.push(`${entry.voorkeur} voorkeur`);

      entry.message = parts.length > 0 ? parts.join(', ') : 'Iedereen beschikbaar';
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
