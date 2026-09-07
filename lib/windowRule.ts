/**
 * Window rule conflict detection - informational only.
 *
 * The window rule is a hard constraint for the solver (solver/constraints.py)
 * but a deliberate non-blocker for manual assignment: a planner filling a
 * gap or swapping a shift by hand must always be able to override it, in
 * consultation with the person taking the shift (see lib/rosterGaps.ts).
 * This module exists purely to surface that a candidate would violate the
 * window rule - grouped in the manual-assign candidate menu and named in
 * the post-assignment warning - never to block anything.
 *
 * Week distance is computed from iso_jaar + iso_week via
 * countWeeksBetween, not by subtracting iso_week alone - a bare iso_week
 * difference is wrong across a year boundary (week 52 of one year and
 * week 1 of the next are one calendar week apart, not fifty-one).
 */

import { db } from '@/db/client';
import { countWeeksBetween } from './holidays';

/** Calendar weeks between two ISO (year, week) pairs; 0 if the same week. */
export function isoWeeksApart(y1: number, w1: number, y2: number, w2: number): number {
  if (y1 === y2 && w1 === w2) return 0;
  const [minY, minW, maxY, maxW] =
    y1 < y2 || (y1 === y2 && w1 < w2) ? [y1, w1, y2, w2] : [y2, w2, y1, w1];
  return countWeeksBetween(minY, minW, maxY, maxW) - 1;
}

/**
 * True if `personId` already has an assignment elsewhere in the period
 * that sits within `windowWeeks` of the target slot's week.
 *
 * `windowWeeks <= 1` means no window restriction at all (matches the
 * solver's `add_window_constraints`, which skips the constraint entirely
 * in that case).
 */
export function personWouldViolateWindowRule(
  periodId: string,
  personId: string,
  targetIsoYear: number,
  targetIsoWeek: number,
  windowWeeks: number,
  excludeSlotId?: string
): boolean {
  if (windowWeeks <= 1) return false;

  const rows = db
    .prepare(
      `SELECT s.iso_jaar, s.iso_week
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       WHERE a.schedule_version_id = ? AND a.person_id = ?
         ${excludeSlotId ? 'AND a.slot_id != ?' : ''}`
    )
    .all(
      ...(excludeSlotId ? [periodId, personId, excludeSlotId] : [periodId, personId])
    ) as Array<{ iso_jaar: number; iso_week: number }>;

  return rows.some(
    (r) => isoWeeksApart(r.iso_jaar, r.iso_week, targetIsoYear, targetIsoWeek) < windowWeeks
  );
}

/**
 * Person ids that already have an assignment elsewhere in the period
 * within `windowWeeks` of the target slot's week - i.e. who would violate
 * the window rule if assigned to that slot. Used to categorise a
 * candidate list in one query instead of calling
 * personWouldViolateWindowRule per person.
 */
export function getWindowConflictingPersonIds(
  periodId: string,
  targetIsoYear: number,
  targetIsoWeek: number,
  windowWeeks: number,
  excludeSlotId?: string
): Set<string> {
  if (windowWeeks <= 1) return new Set();

  const rows = db
    .prepare(
      `SELECT a.person_id, s.iso_jaar, s.iso_week
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       WHERE a.schedule_version_id = ?
         ${excludeSlotId ? 'AND a.slot_id != ?' : ''}`
    )
    .all(...(excludeSlotId ? [periodId, excludeSlotId] : [periodId])) as Array<{
    person_id: string;
    iso_jaar: number;
    iso_week: number;
  }>;

  const conflicting = new Set<string>();
  for (const row of rows) {
    if (isoWeeksApart(row.iso_jaar, row.iso_week, targetIsoYear, targetIsoWeek) < windowWeeks) {
      conflicting.add(row.person_id);
    }
  }
  return conflicting;
}
