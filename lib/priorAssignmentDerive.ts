/**
 * Prior Assignment Derivation Utilities
 *
 * Derives prior assignments (overloopdiensten) from the previous period's
 * published assignments. These are the last N weeks of the prior period
 * that carry over to the new period (calculatePriorAssignmentWeeks).
 *
 * Convention: Dates stored as ISO-8601 strings (YYYY-MM-DD)
 */

import { addDays, dateToISO, parseISO, getISOWeek } from './holidays';
import { resolveRulesetConfig, resolveWindowWeeks } from './rosterBands';

export interface PriorAssignmentInput {
  previousPeriodEndDate: string; // ISO date, should be Sunday-rounded
  currentWindowWeeks: number; // Number of weeks in current period
}

export interface DerivedPriorAssignment {
  datum: string; // ISO date YYYY-MM-DD
  iso_jaar: number;
  iso_week: number;
  teller: string; // 'AVOND', 'WEEKEND', or 'FEESTDAG'
  person_codenaam: string | null; // null means ONBEKEND
  bron: 'AFGELEID' | 'HANDMATIG' | 'ONBEKEND';
  bron_period_id: string | null; // ID of previous period (if AFGELEID)
}

/**
 * How many weeks of the previous period the window rule needs to see: the
 * window itself. A window of N weeks keeps 7 * N days between two shifts
 * (0.22.0), so a shift on the previous period's last Sunday still rules
 * out the first 7 * N - 1 days of this one, and N whole weeks back cover
 * that. Counted in calendar weeks the last N - 1 weeks were enough.
 *
 * Example: with a window of 7 weeks, the last 7 weeks of the previous
 * period.
 */
export function calculatePriorAssignmentWeeks(
  windowWeeks: number
): number {
  return Math.max(0, windowWeeks);
}

/**
 * How many weeks of the previous period a period needs carried over, read
 * straight from its own ruleset.
 *
 * Three routes (the prior-assignments list, auto-derive and confirm) each
 * worked this out themselves with `JSON.parse(...).windowWeeks || 7`, and
 * all three were wrong in the same three ways:
 *
 *   - the fallback was 7 while resolveWindowWeeks - what the solver
 *     actually runs on - falls back to 2;
 *   - `|| 7` turns an explicitly configured 0 ("no window rule") into 7;
 *   - per-teller windows were invisible to them, so a period configured
 *     with only windowWeeksAvond/windowWeeksWeekendFeestdag fell back to 7
 *     regardless of what those said.
 *
 * That matters because this number decides how much history the window
 * rule can see across the period boundary. Too little and someone can be
 * rostered too soon after a shift in the previous period - the one thing
 * carrying these over exists to prevent.
 *
 * The larger of the two windows wins: the history has to be deep enough
 * for whichever rule reaches back furthest.
 */
export function resolvePriorAssignmentWeeks(period: {
  bevroren_ruleset_json?: string | null;
  pool_id: string;
}): number {
  const windows = resolveWindowWeeks(resolveRulesetConfig(period));
  return calculatePriorAssignmentWeeks(Math.max(windows.avond, windows.weekendFeestdag));
}

/**
 * Calculate the date range for prior assignments based on period end date
 * and number of weeks to look back.
 *
 * Returns [startDate, endDate] as ISO strings
 */
/**
 * The last day before this period that the lookback window ends on: the
 * previous published period's end, or, for a pool's first period, the day
 * before this one starts. (It used to be the start date itself, so the
 * window reached one day into the period it was looking back from.)
 */
export function priorAssignmentAnchor(previousPeriodEnd: string | undefined, periodStart: string): string {
  if (previousPeriodEnd) return previousPeriodEnd;
  const dayBefore = parseISO(periodStart);
  dayBefore.setDate(dayBefore.getDate() - 1);
  return dateToISO(dayBefore);
}

export function calculatePriorAssignmentRange(
  previousPeriodEndDate: string,
  weeksToLookBack: number
): [string, string] {
  // previousPeriodEndDate should be a Sunday

  // weeksToLookBack is legitimately 0 (calculatePriorAssignmentWeeks(0),
  // the window switched off) - there's no lookback at all, so the range must
  // come out empty. An inclusive [start, end] tuple can't represent a
  // zero-length range with start <= end, so this returns start = end + 1
  // day instead - still ordered "forward" rather than genuinely inverted,
  // and generateSkeletonPriorAssignments' `while (start <= end)` loop
  // below correctly produces zero entries for it. Handled explicitly
  // rather than left to fall out of the day-count arithmetic, so it can't
  // be mistaken for an off-by-one bug in that formula.
  if (weeksToLookBack <= 0) {
    const dayAfter = parseISO(previousPeriodEndDate);
    dayAfter.setDate(dayAfter.getDate() + 1);
    return [dateToISO(dayAfter), previousPeriodEndDate];
  }

  // Go back weeksToLookBack weeks from the end date
  const endDateParsed = parseISO(previousPeriodEndDate);
  const startDateParsed = new Date(endDateParsed);
  startDateParsed.setDate(startDateParsed.getDate() - (weeksToLookBack * 7 - 1));

  const startDate = dateToISO(startDateParsed);
  const endDate = previousPeriodEndDate;

  return [startDate, endDate];
}

/**
 * Generate skeleton prior assignment entries for the lookback period.
 *
 * This creates entries for every date in the range with ONBEKEND (unknown)
 * person and ONBEKEND source. These will be populated later by:
 * 1. Auto-derivation from previous period's published assignments
 * 2. Manual entry by planner
 * 3. Left as ONBEKEND if no assignment exists
 *
 * Each prior_assignment should have:
 * - One entry per day per shift counter (AVOND, WEEKEND, FEESTDAG)
 */
export function generateSkeletonPriorAssignments(
  startDate: string,
  endDate: string,
  shiftCounters: string[] = ['AVOND', 'WEEKEND', 'FEESTDAG']
): DerivedPriorAssignment[] {
  const assignments: DerivedPriorAssignment[] = [];
  let currentDate = parseISO(startDate);
  const endDateParsed = parseISO(endDate);

  while (currentDate <= endDateParsed) {
    const dateStr = dateToISO(currentDate);
    const [isoYear, isoWeek] = getISOWeek(new Date(currentDate));

    for (const counter of shiftCounters) {
      const assignment: DerivedPriorAssignment = {
        datum: dateStr,
        iso_jaar: isoYear,
        iso_week: isoWeek,
        teller: counter,
        person_codenaam: null,
        bron: 'ONBEKEND',
        bron_period_id: null,
      };
      assignments.push(assignment);
    }

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return assignments;
}

/**
 * Helper to check if two prior assignment date ranges overlap or are adjacent.
 * Used when expanding the lookback period.
 */
export function doRangesOverlap(
  range1Start: string,
  range1End: string,
  range2Start: string,
  range2End: string
): boolean {
  // Widen each range's end by one day so directly-adjacent ranges (no gap,
  // no shared day) count as touching, not just ranges that share a day.
  // Calendar days as text: 24 hours added to a local midnight on the last
  // Sunday of October (a 25 hour day) is still that day at 23:00.
  return addDays(range1End, 1) >= range2Start && addDays(range2End, 1) >= range1Start;
}

/**
 * Count total prior assignment entries across all dates and counters
 */
export function countPriorAssignmentEntries(assignments: DerivedPriorAssignment[]): number {
  return assignments.length;
}

/**
 * Count assignments by derivation source
 */
export function countBySource(assignments: DerivedPriorAssignment[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const assignment of assignments) {
    counts[assignment.bron] = (counts[assignment.bron] || 0) + 1;
  }
  return counts;
}

/**
 * Filter assignments to only those with known persons
 */
export function getAssignedEntries(assignments: DerivedPriorAssignment[]): DerivedPriorAssignment[] {
  return assignments.filter((a) => a.person_codenaam !== null);
}

/**
 * Filter assignments to only unknown persons
 */
export function getUnknownEntries(assignments: DerivedPriorAssignment[]): DerivedPriorAssignment[] {
  return assignments.filter((a) => a.person_codenaam === null);
}

/**
 * Group assignments by date for easier UI display
 */
export function groupByDate(
  assignments: DerivedPriorAssignment[]
): Map<string, DerivedPriorAssignment[]> {
  const grouped = new Map<string, DerivedPriorAssignment[]>();

  for (const assignment of assignments) {
    if (!grouped.has(assignment.datum)) {
      grouped.set(assignment.datum, []);
    }
    grouped.get(assignment.datum)!.push(assignment);
  }

  return grouped;
}

/**
 * Validate prior assignments data integrity
 */
export function validatePriorAssignments(assignments: DerivedPriorAssignment[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check for required fields
  for (let i = 0; i < assignments.length; i++) {
    const a = assignments[i];

    if (!a.datum || !a.datum.match(/^\d{4}-\d{2}-\d{2}$/)) {
      errors.push(`Entry ${i}: invalid date format '${a.datum}'`);
    }

    if (a.iso_week < 1 || a.iso_week > 53) {
      errors.push(`Entry ${i}: invalid ISO week ${a.iso_week}`);
    }

    if (!['AVOND', 'WEEKEND', 'FEESTDAG'].includes(a.teller)) {
      errors.push(`Entry ${i}: invalid teller '${a.teller}'`);
    }

    if (!['AFGELEID', 'HANDMATIG', 'ONBEKEND'].includes(a.bron)) {
      errors.push(`Entry ${i}: invalid source '${a.bron}'`);
    }

    // If AFGELEID or HANDMATIG, must have a person
    if (a.bron !== 'ONBEKEND' && !a.person_codenaam) {
      errors.push(
        `Entry ${i}: source '${a.bron}' requires a person_codenaam`
      );
    }

    // If AFGELEID, must have bron_period_id
    if (a.bron === 'AFGELEID' && !a.bron_period_id) {
      errors.push(`Entry ${i}: source 'AFGELEID' requires bron_period_id`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
