/**
 * GET /api/person/[id]/parttime-patterns/generated-days?period_id=X
 *
 * Lists the real, persisted part-time blocking days for a person in a
 * period - the availability rows that syncAvailabilityForPattern actually
 * generated, not a client-side approximation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';
import { isYearBoundaryWeek } from '@/lib/parttimeSync';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface GeneratedDay {
  datum: string;
  iso_jaar: number;
  iso_week: number;
  weekdag: string;
  pattern_id: string;
  is_year_boundary: boolean;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
    }

    const periodId = req.nextUrl.searchParams.get('period_id');
    if (!periodId) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'MISSING_PERIOD_ID', message: 'de queryparameter period_id is verplicht' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const rows = db
      .prepare(
        `SELECT s.datum, s.iso_jaar, s.iso_week, pp.weekdag, pp.frequentie, a.bron_pattern_id as pattern_id
         FROM dienstrooster_availability a
         JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
         JOIN dienstrooster_parttime_pattern pp ON pp.id = a.bron_pattern_id
         WHERE a.person_id = ? AND a.source = 'PARTTIME' AND s.period_id = ?
         ORDER BY s.datum`
      )
      .all(id, periodId) as Array<{
      datum: string;
      iso_jaar: number;
      iso_week: number;
      weekdag: string;
      frequentie: string;
      pattern_id: string;
    }>;

    // The year-boundary warning only matters for EVEN_WEKEN/ONEVEN_WEKEN -
    // ELKE_WEEK has no week-parity to get thrown off by the ISO week
    // numbering's non-obvious reset at the year seam.
    const generatedDays: GeneratedDay[] = rows.map((row) => ({
      datum: row.datum,
      iso_jaar: row.iso_jaar,
      iso_week: row.iso_week,
      weekdag: row.weekdag,
      pattern_id: row.pattern_id,
      is_year_boundary: row.frequentie !== 'ELKE_WEEK' && isYearBoundaryWeek(row.iso_week),
    }));

    const response: ApiSuccessResponse<{ generated_days: GeneratedDay[] }> = {
      success: true,
      data: { generated_days: generatedDays },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('parttime-generated-days', error);
  }
}
