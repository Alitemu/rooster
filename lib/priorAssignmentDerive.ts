/**
 * Prior Assignment Derivation Utilities
 *
 * Derives prior assignments (overloopdiensten) from the previous period's
 * published assignments. These are the last N-1 weeks of the prior period
 * that carry over to the new period.
 *
 * Convention: Dates stored as ISO-8601 strings (YYYY-MM-DD)
 */

import { dateToISO, parseISO, getISOWeek } from './holidays';

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
 * Count the number of weeks from end of prior period back.
 * For a period with 35 weeks, we look at the last (windowWeeks - 1) weeks.
 *
 * Example: If previous period was 2026-01-05 to 2026-09-06 (35 weeks),
 * and current window is 7 weeks, we derive the last 6 weeks.
 */
export function calculatePriorAssignmentWeeks(
  windowWeeks: number
): number {
  // We need windowWeeks - 1 weeks from the previous period
  return Math.max(0, windowWeeks - 1);
}

/**
 * Calculate the date range for prior assignments based on period end date
 * and number of weeks to look back.
 *
 * Returns [startDate, endDate] as ISO strings
 */
export function calculatePriorAssignmentRange(
  previousPeriodEndDate: string,
  weeksToLookBack: number
): [string, string] {
  // previousPeriodEndDate should be a Sunday
  const endDateParsed = parseISO(previousPeriodEndDate);

  // Go back weeksToLookBack weeks from the end date
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
  const r1Start = parseISO(range1Start);
  const r1End = parseISO(range1End);
  const r2Start = parseISO(range2Start);
  const r2End = parseISO(range2End);

  // Allow 1-day overlap (adjacent weeks)
  return r1End >= r2Start && r2End >= r1Start;
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
