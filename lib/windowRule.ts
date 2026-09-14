/**
 * Window rule conflict detection - informational only.
 *
 * The window rule is a hard constraint for the solver (solver/constraints.py,
 * solver/greedy.py) but a deliberate non-blocker for manual assignment: a
 * planner filling a gap or swapping a shift by hand must always be able to
 * override it, in consultation with the person taking the shift (see
 * lib/rosterGaps.ts). This module exists purely to surface that a candidate
 * would violate the window rule - grouped in the manual-assign candidate
 * menu and named in the post-assignment warning - never to block anything.
 *
 * Week distance is computed from iso_jaar + iso_week via
 * countWeeksBetween, not by subtracting iso_week alone - a bare iso_week
 * difference is wrong across a year boundary (week 52 of one year and
 * week 1 of the next are one calendar week apart, not fifty-one).
 *
 * Per-teller windows: AVOND and WEEKEND+FEESTDAG each have their own
 * (typically larger) same-type cap, but the *smaller* of the two also
 * applies as a floor between every pair of shifts regardless of type -
 * "een weekenddienst kan wel een avonddienst blokkeren en andersom... het
 * minimum geldt dan voor alle diensten". See requiredGapWeeks below, and
 * solver/constraints.py's add_window_constraints for the CP-SAT
 * counterpart this mirrors exactly.
 */

import { db } from '@/db/client';
import { countWeeksBetween } from './holidays';
import type { WindowWeeksConfig } from './rosterBands';

/** Calendar weeks between two ISO (year, week) pairs; 0 if the same week. */
export function isoWeeksApart(y1: number, w1: number, y2: number, w2: number): number {
  if (y1 === y2 && w1 === w2) return 0;
  const [minY, minW, maxY, maxW] =
    y1 < y2 || (y1 === y2 && w1 < w2) ? [y1, w1, y2, w2] : [y2, w2, y1, w1];
  return countWeeksBetween(minY, minW, maxY, maxW) - 1;
}

const windowGroup = (teller: string): 'avond' | 'weekend_feestdag' =>
  teller === 'AVOND' ? 'avond' : 'weekend_feestdag';

/**
 * The minimum gap (in weeks) required between a shift of `tellerA` and one
 * of `tellerB` for the same person, under per-teller windows - same
 * teller (both AVOND, or both WEEKEND/FEESTDAG): that group's own window;
 * different tellers: the smaller of the two windows (the cross-type
 * floor). A period with only the legacy pooled windowWeeks resolves to
 * `windows.avond === windows.weekendFeestdag` (see
 * lib/rosterBands.ts's resolveWindowWeeks), which collapses this to that
 * one shared value regardless of teller - reproducing the old pooled
 * behaviour exactly, not a special case to branch on separately.
 */
export function requiredGapWeeks(tellerA: string, tellerB: string, windows: WindowWeeksConfig): number {
  if (windowGroup(tellerA) === windowGroup(tellerB)) {
    return tellerA === 'AVOND' ? windows.avond : windows.weekendFeestdag;
  }
  return Math.min(windows.avond, windows.weekendFeestdag);
}

/**
 * True if `personId` already has an assignment elsewhere in the period
 * that sits too close (per requiredGapWeeks) to a shift of `targetTeller`
 * in `targetIsoYear`/`targetIsoWeek`.
 */
export function personWouldViolateWindowRule(
  periodId: string,
  personId: string,
  targetIsoYear: number,
  targetIsoWeek: number,
  targetTeller: string,
  windows: WindowWeeksConfig,
  excludeSlotId?: string
): boolean {
  if (windows.avond <= 1 && windows.weekendFeestdag <= 1) return false;

  const rows = db
    .prepare(
      `SELECT s.iso_jaar, s.iso_week, st.teller
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = ? AND a.person_id = ?
         ${excludeSlotId ? 'AND a.slot_id != ?' : ''}`
    )
    .all(
      ...(excludeSlotId ? [periodId, personId, excludeSlotId] : [periodId, personId])
    ) as Array<{ iso_jaar: number; iso_week: number; teller: string }>;

  return rows.some((r) => {
    const required = requiredGapWeeks(targetTeller, r.teller, windows);
    return required > 1 && isoWeeksApart(r.iso_jaar, r.iso_week, targetIsoYear, targetIsoWeek) < required;
  });
}

/**
 * Person ids that already have an assignment elsewhere in the period too
 * close (per requiredGapWeeks) to a shift of `targetTeller` in
 * `targetIsoYear`/`targetIsoWeek` - i.e. who would violate the window rule
 * if assigned to that slot. Used to categorise a candidate list in one
 * query instead of calling personWouldViolateWindowRule per person.
 */
export function getWindowConflictingPersonIds(
  periodId: string,
  targetIsoYear: number,
  targetIsoWeek: number,
  targetTeller: string,
  windows: WindowWeeksConfig,
  excludeSlotId?: string
): Set<string> {
  if (windows.avond <= 1 && windows.weekendFeestdag <= 1) return new Set();

  const rows = db
    .prepare(
      `SELECT a.person_id, s.iso_jaar, s.iso_week, st.teller
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = ?
         ${excludeSlotId ? 'AND a.slot_id != ?' : ''}`
    )
    .all(...(excludeSlotId ? [periodId, excludeSlotId] : [periodId])) as Array<{
    person_id: string;
    iso_jaar: number;
    iso_week: number;
    teller: string;
  }>;

  const conflicting = new Set<string>();
  for (const row of rows) {
    const required = requiredGapWeeks(targetTeller, row.teller, windows);
    if (required > 1 && isoWeeksApart(row.iso_jaar, row.iso_week, targetIsoYear, targetIsoWeek) < required) {
      conflicting.add(row.person_id);
    }
  }
  return conflicting;
}
