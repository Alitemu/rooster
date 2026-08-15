/**
 * Holiday Calculations for Dutch Holidays
 *
 * Convention: Delta values are negative = fewer shifts, positive = more shifts
 * This file uses ISO-8601 dates (YYYY-MM-DD)
 */

export type HolidayGroup = 'NIEUWJAAR' | 'PASEN' | 'KONINGSDAG' | 'BEVRIJDINGSDAG' | 'HEMELVAART' | 'PINKSTEREN' | 'KERST';

export interface Holiday {
  date: string; // ISO date YYYY-MM-DD
  name: string;
  group: HolidayGroup;
}

/**
 * Calculate Easter Sunday using the Anonymous Gregorian algorithm (Meeus/Jones/Butcher)
 * Reference: https://en.wikipedia.org/wiki/Computus
 */
function calculateEaster(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

/**
 * Get all Dutch holidays for a given year
 */
export function getHolidaysForYear(year: number, liberationEvery5Years: boolean = true): Holiday[] {
  const holidays: Holiday[] = [];

  // Nieuwjaarsdag - January 1
  holidays.push({
    date: `${year}-01-01`,
    name: 'Nieuwjaarsdag',
    group: 'NIEUWJAAR',
  });

  // Easter-based holidays
  const easter = calculateEaster(year);
  const easterDate = dateToISO(easter);

  // Eerste Paasdag
  holidays.push({
    date: easterDate,
    name: 'Eerste Paasdag',
    group: 'PASEN',
  });

  // Tweede Paasdag (Easter + 1 day)
  const secondEaster = new Date(easter);
  secondEaster.setDate(secondEaster.getDate() + 1);
  holidays.push({
    date: dateToISO(secondEaster),
    name: 'Tweede Paasdag',
    group: 'PASEN',
  });

  // Koningsdag - April 27, or April 26 if April 27 is Sunday
  let kingsDay = new Date(year, 3, 27, 0, 0, 0, 0);
  if (kingsDay.getDay() === 0) { // Sunday
    kingsDay.setDate(26);
  }
  holidays.push({
    date: dateToISO(kingsDay),
    name: 'Koningsdag',
    group: 'KONINGSDAG',
  });

  // Bevrijdingsdag - May 5, but only every 5 years (or always if liberationEvery5Years is false)
  if (!liberationEvery5Years || year % 5 === 0) {
    holidays.push({
      date: `${year}-05-05`,
      name: 'Bevrijdingsdag',
      group: 'BEVRIJDINGSDAG',
    });
  }

  // Hemelvaartsdag - Easter + 39 days (always a Thursday)
  const ascension = new Date(easter);
  ascension.setDate(ascension.getDate() + 39);
  holidays.push({
    date: dateToISO(ascension),
    name: 'Hemelvaartsdag',
    group: 'HEMELVAART',
  });

  // Eerste Pinksterdag - Easter + 49 days
  const pentecost1 = new Date(easter);
  pentecost1.setDate(pentecost1.getDate() + 49);
  holidays.push({
    date: dateToISO(pentecost1),
    name: 'Eerste Pinksterdag',
    group: 'PINKSTEREN',
  });

  // Tweede Pinksterdag - Easter + 50 days
  const pentecost2 = new Date(easter);
  pentecost2.setDate(pentecost2.getDate() + 50);
  holidays.push({
    date: dateToISO(pentecost2),
    name: 'Tweede Pinksterdag',
    group: 'PINKSTEREN',
  });

  // Eerste Kerstdag - December 25
  holidays.push({
    date: `${year}-12-25`,
    name: 'Eerste Kerstdag',
    group: 'KERST',
  });

  // Tweede Kerstdag - December 26
  holidays.push({
    date: `${year}-12-26`,
    name: 'Tweede Kerstdag',
    group: 'KERST',
  });

  return holidays.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Get ISO week number for a date
 * Returns [isoYear, isoWeek]
 */
export function getISOWeek(date: Date): [number, number] {
  // Strip time-of-day, working in local dates (avoid mutating the input)
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  // Move to the Thursday of this ISO week - the ISO year and week number
  // are both defined relative to that Thursday
  const dayNum = d.getDay() || 7; // Monday = 1 .. Sunday = 7
  d.setDate(d.getDate() + 4 - dayNum);

  const yearStart = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

  return [d.getFullYear(), week];
}

/**
 * Get ISO week range for a given week
 * Returns [startDate, endDate] as ISO strings
 */
export function getWeekRange(isoYear: number, isoWeek: number): [string, string] {
  // Start with Jan 4 of the ISO year (always in week 1)
  const jan4 = new Date(isoYear, 0, 4);
  const start = new Date(jan4);

  // Find Monday of week 1
  const dayOfWeek = jan4.getDay();
  start.setDate(jan4.getDate() - dayOfWeek + 1);

  // Move to the target week
  start.setDate(start.getDate() + (isoWeek - 1) * 7);

  // Sunday is 6 days after Monday
  const end = new Date(start);
  end.setDate(end.getDate() + 6);

  return [dateToISO(start), dateToISO(end)];
}

/**
 * Round date to Monday (start of week)
 * Used for period start dates
 */
export function roundToMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Round date to Sunday (end of week)
 * Used for period end dates
 */
export function roundToSunday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? 0 : 7);
  d.setDate(diff);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Get the Monday and Sunday dates for a period
 * @param startDate - any date in the period
 * @returns [mondayISO, sundayISO]
 */
export function getPeriodBoundaries(startDate: Date): [string, string] {
  const monday = roundToMonday(startDate);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  return [dateToISO(monday), dateToISO(sunday)];
}

/**
 * Count weeks between two ISO week dates
 * Both dates inclusive
 */
export function countWeeksBetween(isoYear1: number, isoWeek1: number, isoYear2: number, isoWeek2: number): number {
  if (isoYear1 === isoYear2) {
    return isoWeek2 - isoWeek1 + 1;
  }

  // Calculate weeks from year1 to end of year1
  const weeksInYear1 = getWeeksInYear(isoYear1);
  let count = weeksInYear1 - isoWeek1 + 1;

  // Add full years between
  for (let y = isoYear1 + 1; y < isoYear2; y++) {
    count += getWeeksInYear(y);
  }

  // Add weeks from start of year2 to target week
  count += isoWeek2;

  return count;
}

/**
 * Get number of ISO weeks in a year
 * Most years have 52 weeks, some have 53
 */
export function getWeeksInYear(year: number): number {
  // December 28 always falls in the last ISO week of its year (per the
  // ISO-8601 definition), unlike December 31 which can roll into week 1
  // of the following year.
  const dec28 = new Date(year, 11, 28);

  const [, dec28Week] = getISOWeek(dec28);
  return dec28Week;
}

/**
 * Convert JavaScript Date to ISO string (YYYY-MM-DD)
 */
export function dateToISO(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Parse ISO date string to Date
 */
export function parseISO(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

/**
 * Add days to an ISO date string
 */
export function addDays(dateStr: string, days: number): string {
  const date = parseISO(dateStr);
  date.setDate(date.getDate() + days);
  return dateToISO(date);
}

/**
 * Get all holidays in a date range
 */
export function getHolidaysInRange(startDate: string, endDate: string): Holiday[] {
  const start = parseISO(startDate);
  const end = parseISO(endDate);

  const holidays: Holiday[] = [];

  // Collect holidays from all years in range
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();

  for (let year = startYear; year <= endYear; year++) {
    const yearHolidays = getHolidaysForYear(year);
    for (const holiday of yearHolidays) {
      if (holiday.date >= startDate && holiday.date <= endDate) {
        holidays.push(holiday);
      }
    }
  }

  return holidays;
}

/**
 * Check if a date is a holiday
 */
export function isHoliday(dateStr: string): boolean {
  const date = parseISO(dateStr);
  const year = date.getFullYear();
  const holidays = getHolidaysForYear(year);
  return holidays.some(h => h.date === dateStr);
}

/**
 * Get the holiday info for a specific date, if it is a holiday
 */
export function getHolidayInfo(dateStr: string): Holiday | null {
  const date = parseISO(dateStr);
  const year = date.getFullYear();
  const holidays = getHolidaysForYear(year);
  return holidays.find(h => h.date === dateStr) || null;
}
