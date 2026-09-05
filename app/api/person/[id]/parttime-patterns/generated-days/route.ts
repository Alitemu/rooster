/**
 * GET /api/person/[id]/parttime-patterns/generated-days?period_id=X
 *
 * Lists the part-time blocking days for a person in a period. Once the
 * period is OPEN (or beyond), these are the real, persisted availability
 * rows syncAvailabilityForPattern actually generated. Before that - still
 * CONCEPT, so no shift slots exist yet to generate rows against - this
 * instead previews what those days *will* be, computed straight from the
 * pattern and the period's own date range, so a participant isn't staring
 * at a blank calendar until the planner opens the period.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';
import { isYearBoundaryWeek, previewPatternDates, findBlockedElsewhereDays, type PatternRule } from '@/lib/parttimeSync';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface GeneratedDay {
  datum: string;
  iso_jaar: number;
  iso_week: number;
  weekdag: string;
  pattern_id: string;
  is_year_boundary: boolean;
}

interface BlockedElsewhereDay {
  datum: string;
  weekdag: string;
  pattern_id: string;
  source: string;
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

    const period = db
      .prepare('SELECT status, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { status: string; start_datum: string; eind_datum: string } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${periodId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    let generatedDays: GeneratedDay[];
    let blockedElsewhereDays: BlockedElsewhereDay[] = [];

    if (period.status === 'CONCEPT') {
      // No slots exist yet - preview straight from the person's own
      // patterns instead of joining against rows that aren't there.
      const patterns = db
        .prepare(
          `SELECT id, weekdag, frequentie, geldig_vanaf, geldig_tot
           FROM dienstrooster_parttime_pattern WHERE person_id = ?`
        )
        .all(id) as Array<{ id: string } & PatternRule>;

      generatedDays = patterns
        .flatMap((pattern) =>
          previewPatternDates(pattern, period.start_datum, period.eind_datum).map((day) => ({
            datum: day.datum,
            iso_jaar: day.iso_jaar,
            iso_week: day.iso_week,
            weekdag: pattern.weekdag,
            pattern_id: pattern.id,
            is_year_boundary: pattern.frequentie !== 'ELKE_WEEK' && isYearBoundaryWeek(day.iso_week),
          }))
        )
        .sort((a, b) => a.datum.localeCompare(b.datum));
    } else {
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
      generatedDays = rows.map((row) => ({
        datum: row.datum,
        iso_jaar: row.iso_jaar,
        iso_week: row.iso_week,
        weekdag: row.weekdag,
        pattern_id: row.pattern_id,
        is_year_boundary: row.frequentie !== 'ELKE_WEEK' && isYearBoundaryWeek(row.iso_week),
      }));

      // A pattern never overwrites a slot that already has a different
      // availability row (e.g. an imported historical blockade, or an
      // absence) - reconcilePatternForPeriod deliberately skips those. That
      // day is still genuinely blocked, just not tagged PARTTIME, so
      // without this it would look like the pattern silently "missed" a
      // day it should have covered.
      const patterns = db
        .prepare(
          `SELECT id, weekdag, frequentie, geldig_vanaf, geldig_tot
           FROM dienstrooster_parttime_pattern WHERE person_id = ?`
        )
        .all(id) as Array<{ id: string } & PatternRule>;

      if (patterns.length > 0) {
        const slots = db
          .prepare('SELECT id, datum, iso_week FROM dienstrooster_shift_slot WHERE period_id = ?')
          .all(periodId) as Array<{ id: string; datum: string; iso_week: number }>;
        const generatedDatums = new Set(generatedDays.map((d) => d.datum));

        const otherSourceRows = db
          .prepare(
            `SELECT a.slot_id, a.source FROM dienstrooster_availability a
             JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
             WHERE a.person_id = ? AND s.period_id = ? AND a.source != 'PARTTIME'`
          )
          .all(id, periodId) as Array<{ slot_id: string; source: string }>;
        const otherSourceBySlotId = new Map(otherSourceRows.map((r) => [r.slot_id, r.source]));

        const patternById = new Map(patterns.map((p) => [p.id, p]));
        blockedElsewhereDays = findBlockedElsewhereDays(patterns, slots, generatedDatums, otherSourceBySlotId).map(
          (day) => ({ ...day, weekdag: patternById.get(day.pattern_id)!.weekdag })
        );
      }
    }

    const response: ApiSuccessResponse<{
      generated_days: GeneratedDay[];
      blocked_elsewhere_days: BlockedElsewhereDay[];
    }> = {
      success: true,
      data: { generated_days: generatedDays, blocked_elsewhere_days: blockedElsewhereDays },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('parttime-generated-days', error);
  }
}
