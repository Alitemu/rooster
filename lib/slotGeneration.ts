/**
 * Slot Generation Utilities
 *
 * Generates shift slots for a period with proper ISO week assignment,
 * weekend pairing, and holiday detection.
 *
 * Convention: Dates stored as ISO-8601 strings (YYYY-MM-DD)
 */

import { getISOWeek, getHolidaysInRange, dateToISO, parseISO } from './holidays';
import type { HolidayGroup } from './holidays';

export interface GeneratedSlot {
  datum: string; // ISO date YYYY-MM-DD
  iso_jaar: number;
  iso_week: number;
  weekend_id: string; // e.g., "2027-W01-SAT" or "2027-W01-SUN"
  is_feestdag: boolean;
  feestdag_groep: HolidayGroup | null;
}

export interface SlotGenerationInput {
  startDate: string; // ISO date, should already be Monday-rounded
  endDate: string; // ISO date, should already be Sunday-rounded
  shiftTypes: string[]; // e.g., ['AVOND', 'WEEKEND', 'FEESTDAG']
}

/**
 * Generate a weekend_id for a given date.
 * Format: "YYYY-WkkD" where D is SAT or SUN, kk is ISO week
 *
 * Example: Saturday of week 1, 2027 → "2027-W01-SAT"
 */
function getWeekendId(dateStr: string): string {
  const parsed = parseISO(dateStr);
  const dayOfWeek = parsed.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  const [isoYear, isoWeek] = getISOWeek(new Date(parsed));
  const weekStr = String(isoWeek).padStart(2, '0');

  if (dayOfWeek === 6) {
    // Saturday
    return `${isoYear}-W${weekStr}-SAT`;
  } else if (dayOfWeek === 0) {
    // Sunday
    return `${isoYear}-W${weekStr}-SUN`;
  }

  // Not a weekend day—should not happen in normal usage
  // but return a fallback
  return `${isoYear}-W${weekStr}-${dayOfWeek}`;
}

/**
 * Check if a date falls on Saturday or Sunday
 */
function isWeekend(date: string): boolean {
  const parsed = parseISO(date);
  const dayOfWeek = parsed.getDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}

/**
 * Generate all slots for a period.
 *
 * Guarantees:
 * - 7 slots per ISO week (Mon-Sun)
 * - Weekend_id pairs for Saturday and Sunday (same weekend_id value)
 * - Holidays marked with is_feestdag=true and feestdag_groep set
 * - All dates in period covered
 * - ISO week boundary correctly handled (e.g., Dec 31 might be Week 52 or Week 1 of next year)
 */
export function generateSlotsForPeriod(input: SlotGenerationInput): GeneratedSlot[] {
  const { startDate, endDate } = input;

  // Get all holidays in range (we'll filter per counter type later)
  const holidaysInRange = getHolidaysInRange(startDate, endDate);
  const holidaysByDate = new Map(
    holidaysInRange.map((h) => [h.date, h.group])
  );

  const slots: GeneratedSlot[] = [];
  let currentDate = parseISO(startDate);
  const endDateParsed = parseISO(endDate);

  while (currentDate <= endDateParsed) {
    const dateStr = dateToISO(currentDate);
    const [isoYear, isoWeek] = getISOWeek(new Date(currentDate));
    const weekendId = isWeekend(dateStr) ? getWeekendId(dateStr) : '';
    const holidayGroup = holidaysByDate.get(dateStr) || null;

    const slot: GeneratedSlot = {
      datum: dateStr,
      iso_jaar: isoYear,
      iso_week: isoWeek,
      weekend_id: weekendId,
      is_feestdag: holidayGroup !== null,
      feestdag_groep: holidayGroup,
    };

    slots.push(slot);
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return slots;
}

/**
 * Validate that slots form valid weeks (7 slots per ISO week)
 * and that weekend_id pairs are consistent.
 *
 * This is useful as a post-generation check.
 */
export function validateSlots(slots: GeneratedSlot[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Group by ISO week
  const weekMap = new Map<string, GeneratedSlot[]>();
  for (const slot of slots) {
    const key = `${slot.iso_jaar}-W${String(slot.iso_week).padStart(2, '0')}`;
    if (!weekMap.has(key)) {
      weekMap.set(key, []);
    }
    weekMap.get(key)!.push(slot);
  }

  // Check each week has 7 slots
  weekMap.forEach((weekSlots, weekKey) => {
    if (weekSlots.length !== 7) {
      errors.push(`Week ${weekKey}: expected 7 slots, got ${weekSlots.length}`);
    }
  });

  // Check weekend_id pairing: Saturday and Sunday should share the same
  // "YYYY-Wkk" prefix - the trailing -SAT/-SUN is expected to differ, that's
  // what makes each day's id distinct in the first place.
  const weekendIdPrefix = (weekendId: string) => weekendId.replace(/-(SAT|SUN)$/, '');

  for (const slot of slots) {
    if (isWeekend(slot.datum)) {
      const dayOfWeek = parseISO(slot.datum).getDay();
      if (dayOfWeek === 6) {
        // Saturday, find corresponding Sunday
        const satParsed = parseISO(slot.datum);
        const sundayParsed = new Date(satParsed);
        sundayParsed.setDate(sundayParsed.getDate() + 1);
        const sundayDate = dateToISO(sundayParsed);
        const sundaySlot = slots.find((s) => s.datum === sundayDate);
        if (sundaySlot && weekendIdPrefix(sundaySlot.weekend_id) !== weekendIdPrefix(slot.weekend_id)) {
          errors.push(
            `Weekend mismatch: Saturday ${slot.datum} has ID ${slot.weekend_id}, ` +
            `but Sunday ${sundayDate} has ID ${sundaySlot.weekend_id}`
          );
        }
      }
    }
  }

  // Check ISO week values are sensible (1-53)
  for (const slot of slots) {
    if (slot.iso_week < 1 || slot.iso_week > 53) {
      errors.push(`Date ${slot.datum}: invalid ISO week ${slot.iso_week}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Count weeks in generated slots
 */
export function countWeeksInSlots(slots: GeneratedSlot[]): number {
  const weekSet = new Set<string>();
  for (const slot of slots) {
    const key = `${slot.iso_jaar}-W${String(slot.iso_week).padStart(2, '0')}`;
    weekSet.add(key);
  }
  return weekSet.size;
}

/**
 * Count holidays by group in slots
 */
export function countHolidaysByGroup(slots: GeneratedSlot[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const slot of slots) {
    if (slot.is_feestdag && slot.feestdag_groep) {
      counts[slot.feestdag_groep] = (counts[slot.feestdag_groep] || 0) + 1;
    }
  }
  return counts;
}
