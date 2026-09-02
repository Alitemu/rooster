/**
 * GET /api/person/[id]/parttime-patterns/generated-days?period_id=X
 *
 * Lists the real, persisted part-time blocking days for a person in a
 * period - the availability rows that syncAvailabilityForPattern actually
 * generated, not a client-side approximation.
 *
 * Also lists "conflict days": dates that match a pattern's weekday (and,
 * for EVEN_WEKEN/ONEVEN_WEKEN, week parity) but were never turned into a
 * PARTTIME row because that slot already had some other marking - the
 * "never touching a slot a person has manually blocked themselves" rule
 * in lib/parttimeSync.ts. Without surfacing these, a day the participant
 * expects to see blocked just silently isn't there, with no way to tell
 * why from the UI alone.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';
import { isYearBoundaryWeek, matchSlotsToPattern, type ParttimePatternRow } from '@/lib/parttimeSync';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface GeneratedDay {
  datum: string;
  iso_jaar: number;
  iso_week: number;
  weekdag: string;
  pattern_id: string;
  is_year_boundary: boolean;
}

interface ConflictDay {
  datum: string;
  iso_week: number;
  weekdag: string;
  pattern_id: string;
  reden: string; // Dutch, ready to show directly
}

interface SlotRow {
  id: string;
  datum: string;
  iso_jaar: number;
  iso_week: number;
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

    // Conflict days: for every pattern this person has, find every slot in
    // this period that matches its weekday/parity, then subtract the ones
    // that actually became a PARTTIME row above - what's left matched the
    // rule but lost to something else already on that slot.
    const patterns = db
      .prepare(
        `SELECT id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot
         FROM dienstrooster_parttime_pattern WHERE person_id = ?`
      )
      .all(id) as ParttimePatternRow[];

    const conflictDays: ConflictDay[] = [];
    if (patterns.length > 0) {
      const slots = db
        .prepare('SELECT id, datum, iso_jaar, iso_week FROM dienstrooster_shift_slot WHERE period_id = ?')
        .all(periodId) as SlotRow[];
      const slotById = new Map(slots.map((s) => [s.id, s]));
      const generatedSlotKeys = new Set(rows.map((r) => `${r.pattern_id}|${r.datum}`));

      const availabilityStmt = db.prepare(
        `SELECT blocking_level, source FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?`
      );

      const REASON: Record<string, string> = {
        MANUAL: 'deze dag stond al zelf op "liever niet" of "geblokkeerd" gezet',
        ABSENCE: 'deze dag valt binnen een geregistreerde afwezigheid',
        PARTTIME: 'deze dag komt al door een ander deeltijdpatroon',
      };

      for (const pattern of patterns) {
        const matchedSlotIds = matchSlotsToPattern(pattern, slots);
        for (const slotId of matchedSlotIds) {
          if (generatedSlotKeys.has(`${pattern.id}|${slotById.get(slotId)?.datum}`)) continue;
          const existing = availabilityStmt.get(id, slotId) as { blocking_level: string; source: string } | undefined;
          if (!existing) continue; // shouldn't happen (sync would have inserted it), but nothing to explain
          const slot = slotById.get(slotId);
          if (!slot) continue;
          conflictDays.push({
            datum: slot.datum,
            iso_week: slot.iso_week,
            weekdag: pattern.weekdag,
            pattern_id: pattern.id,
            reden: REASON[existing.source] || 'deze dag heeft al een andere markering',
          });
        }
      }
      conflictDays.sort((a, b) => a.datum.localeCompare(b.datum));
    }

    const response: ApiSuccessResponse<{ generated_days: GeneratedDay[]; conflict_days: ConflictDay[] }> = {
      success: true,
      data: { generated_days: generatedDays, conflict_days: conflictDays },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('parttime-generated-days', error);
  }
}
