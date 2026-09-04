/**
 * Calendar month grid builder
 *
 * Shared by PreferencesCalendar and PartTimeCheckStep: splits a date range
 * into calendar-month groups, each laid out as a table-friendly grid of
 * Monday-Sunday rows. A month's grid always starts on its actual 1st (or
 * the range's start date, if later) and ends on its actual last day (or
 * the range's end date, if earlier) - it never shows a neighboring month's
 * days. Where a month doesn't start on a Monday or end on a Sunday, the
 * leftover cells in that row are `null` rather than the adjacent month's
 * date, so every month reads as its own block instead of two months
 * sharing a row.
 */

import { dateToISO, getISOWeek } from './holidays';

export interface CalendarWeekRow {
  isoWeek: number;
  days: (string | null)[]; // Monday..Sunday; null = outside this month
}

export interface CalendarMonthGroup {
  label: string;
  weeks: CalendarWeekRow[];
}

export function buildMonthGroups(startDate: Date, endDate: Date): CalendarMonthGroup[] {
  const groups: CalendarMonthGroup[] = [];
  let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());

  while (cursor <= end) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const label = cursor.toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' });

    const firstOfMonth = new Date(year, month, 1);
    const lastOfMonth = new Date(year, month + 1, 0);
    const monthStart = firstOfMonth > cursor ? firstOfMonth : cursor;
    const monthEnd = lastOfMonth < end ? lastOfMonth : end;

    const gridStart = new Date(monthStart);
    const startWeekday = (gridStart.getDay() + 6) % 7; // Monday = 0 .. Sunday = 6
    gridStart.setDate(gridStart.getDate() - startWeekday);

    const gridEnd = new Date(monthEnd);
    const endWeekday = (gridEnd.getDay() + 6) % 7;
    gridEnd.setDate(gridEnd.getDate() + (6 - endWeekday));

    const weeks: CalendarWeekRow[] = [];
    const d = new Date(gridStart);
    while (d <= gridEnd) {
      const [, isoWeek] = getISOWeek(d);
      const days: (string | null)[] = [];
      for (let i = 0; i < 7; i++) {
        days.push(d >= monthStart && d <= monthEnd ? dateToISO(d) : null);
        d.setDate(d.getDate() + 1);
      }
      weeks.push({ isoWeek, days });
    }

    groups.push({ label, weeks });
    cursor = new Date(lastOfMonth.getFullYear(), lastOfMonth.getMonth(), lastOfMonth.getDate() + 1);
  }

  return groups;
}
