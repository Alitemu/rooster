import { describe, it, expect } from 'vitest';
import {
  getHolidaysForYear,
  getISOWeek,
  getWeekRange,
  roundToMonday,
  roundToSunday,
  dateToISO,
  parseISO,
  getWeeksInYear,
  getHolidaysInRange,
  isHoliday,
  getHolidayInfo,
} from './holidays';

describe('holidays.ts', () => {
  describe('Easter calculation (via getHolidaysForYear)', () => {
    it('should calculate Easter correctly for known years', () => {
      // Easter 2024: April 31 (actually April 31 doesn't exist, let me check)
      // Easter 2024: March 31
      const holidays2024 = getHolidaysForYear(2024);
      const easterDay = holidays2024.find(h => h.name === 'Eerste Paasdag');
      expect(easterDay?.date).toBe('2024-03-31');

      // Easter 2027: March 28
      const holidays2027 = getHolidaysForYear(2027);
      const easterDay2027 = holidays2027.find(h => h.name === 'Eerste Paasdag');
      expect(easterDay2027?.date).toBe('2027-03-28');

      // Easter 2034: April 9
      const holidays2034 = getHolidaysForYear(2034);
      const easterDay2034 = holidays2034.find(h => h.name === 'Eerste Paasdag');
      expect(easterDay2034?.date).toBe('2034-04-09');
    });

    it('should calculate derived holidays correctly (Easter + N days)', () => {
      const holidays2024 = getHolidaysForYear(2024);

      // Easter 2024 is March 31
      // Hemelvaartsdag: Easter + 39 = May 9, 2024
      const ascension = holidays2024.find(h => h.name === 'Hemelvaartsdag');
      expect(ascension?.date).toBe('2024-05-09');

      // Eerste Pinksterdag: Easter + 49 = May 19, 2024
      const pentecost1 = holidays2024.find(h => h.name === 'Eerste Pinksterdag');
      expect(pentecost1?.date).toBe('2024-05-19');

      // Tweede Pinksterdag: Easter + 50 = May 20, 2024
      const pentecost2 = holidays2024.find(h => h.name === 'Tweede Pinksterdag');
      expect(pentecost2?.date).toBe('2024-05-20');
    });

    it('should include all holidays for a year', () => {
      const holidays = getHolidaysForYear(2025);
      const names = holidays.map(h => h.name);

      expect(names).toContain('Nieuwjaarsdag');
      expect(names).toContain('Eerste Paasdag');
      expect(names).toContain('Tweede Paasdag');
      expect(names).toContain('Koningsdag');
      expect(names).toContain('Bevrijdingsdag'); // 2025 is divisible by 5
      expect(names).toContain('Hemelvaartsdag');
      expect(names).toContain('Eerste Pinksterdag');
      expect(names).toContain('Tweede Pinksterdag');
      expect(names).toContain('Eerste Kerstdag');
      expect(names).toContain('Tweede Kerstdag');
    });

    it('should exclude Bevrijdingsdag in non-5-year years', () => {
      const holidays2023 = getHolidaysForYear(2023);
      const hasLiberation = holidays2023.some(h => h.name === 'Bevrijdingsdag');
      expect(hasLiberation).toBe(false);

      const holidays2025 = getHolidaysForYear(2025);
      const hasLiberation2025 = holidays2025.some(h => h.name === 'Bevrijdingsdag');
      expect(hasLiberation2025).toBe(true);
    });

    it('should handle Koningsdag on Sunday correctly', () => {
      // 2023: April 27 is a Thursday - no adjustment
      const holidays2023 = getHolidaysForYear(2023);
      const koningsdag2023 = holidays2023.find(h => h.name === 'Koningsdag');
      expect(koningsdag2023?.date).toBe('2023-04-27');

      // Need to find a year where April 27 is Sunday
      // 2025: April 27 is Sunday → should be April 26
      const holidays2025 = getHolidaysForYear(2025);
      const koningsdag2025 = holidays2025.find(h => h.name === 'Koningsdag');
      expect(koningsdag2025?.date).toBe('2025-04-26');
    });
  });

  describe('ISO Week calculations', () => {
    it('should calculate ISO week correctly for dates', () => {
      // January 4, 2024 is in week 1
      const date1 = new Date(2024, 0, 4);
      const [year1, week1] = getISOWeek(date1);
      expect(year1).toBe(2024);
      expect(week1).toBe(1);

      // December 31, 2024 - check which week it's in
      const date2 = new Date(2024, 11, 31);
      const [year2, week2] = getISOWeek(date2);
      // 2024 has 53 ISO weeks (since Dec 31 is Tuesday)
      expect(year2).toBe(2025);
      expect(week2).toBe(1); // It's already in 2025's week 1

      // More reliable test: January 1, 2024 (Monday)
      const date3 = new Date(2024, 0, 1);
      const [year3, week3] = getISOWeek(date3);
      expect([year3, week3]).toEqual([2024, 1]);
    });

    it('should return correct week range', () => {
      // 2024, week 1
      const [start, end] = getWeekRange(2024, 1);
      expect(start).toBe('2024-01-01');
      expect(end).toBe('2024-01-07');

      // 2024, week 2
      const [start2, end2] = getWeekRange(2024, 2);
      expect(start2).toBe('2024-01-08');
      expect(end2).toBe('2024-01-14');
    });

    it('should return the correct week 1 when Jan 4 falls on a Sunday', () => {
      // 2026-01-04 is a Sunday, so week 1 of 2026 starts the Monday
      // *before* it (2025-12-29), not the Monday after (2026-01-05) - a
      // naive `jan4 - dayOfWeek + 1` computes the latter and is off by a
      // full week for every year this happens (2015, 2026, 2032, ...).
      const [start, end] = getWeekRange(2026, 1);
      expect(start).toBe('2025-12-29');
      expect(end).toBe('2026-01-04');
    });

    it('should count weeks in year correctly', () => {
      // Most years have 52 weeks
      const weeks2024 = getWeeksInYear(2024);
      expect(weeks2024).toBe(52); // 2024 has 52 weeks (Jan 1 is a Monday)

      const weeks2025 = getWeeksInYear(2025);
      expect(weeks2025).toBe(52); // 2025 has 52 weeks

      const weeks2026 = getWeeksInYear(2026);
      expect(weeks2026).toBe(53); // 2026 has 53 weeks (Jan 1 is a Thursday)
    });
  });

  describe('Period boundary rounding', () => {
    it('should round to Monday', () => {
      // 2024-01-05 is a Friday
      const date = new Date(2024, 0, 5);
      const monday = roundToMonday(date);
      expect(dateToISO(monday)).toBe('2024-01-01'); // Previous Monday

      // 2024-01-01 is already Monday
      const date2 = new Date(2024, 0, 1);
      const monday2 = roundToMonday(date2);
      expect(dateToISO(monday2)).toBe('2024-01-01');

      // 2024-01-07 is Sunday
      const date3 = new Date(2024, 0, 7);
      const monday3 = roundToMonday(date3);
      expect(dateToISO(monday3)).toBe('2024-01-01'); // Previous Monday
    });

    it('should round to Sunday', () => {
      // 2024-01-05 is Friday
      const date = new Date(2024, 0, 5);
      const sunday = roundToSunday(date);
      expect(dateToISO(sunday)).toBe('2024-01-07'); // Following Sunday

      // 2024-01-07 is already Sunday
      const date2 = new Date(2024, 0, 7);
      const sunday2 = roundToSunday(date2);
      expect(dateToISO(sunday2)).toBe('2024-01-07');
    });
  });

  describe('Date utilities', () => {
    it('should convert between Date and ISO string', () => {
      const date = new Date(2024, 0, 15); // Jan 15, 2024
      const iso = dateToISO(date);
      expect(iso).toBe('2024-01-15');

      const parsed = parseISO(iso);
      expect(parsed.getFullYear()).toBe(2024);
      expect(parsed.getMonth()).toBe(0); // January
      expect(parsed.getDate()).toBe(15);
    });

    it('dateToISO must not shift the date in a non-UTC timezone', () => {
      // Reads the LOCAL calendar date - not toISOString()'s UTC one. This
      // module runs both server-side (a UTC container, where the bug this
      // proves was invisible) and client-side, in the browser's actual
      // local timezone (Europe/Amsterdam for this app's real users, always
      // ahead of UTC) - a UTC conversion of a local-midnight Date silently
      // rolls it back a day there. Compounded with a second bug in the
      // preferences calendar's own week-count, a real date could land
      // under the wrong weekday column entirely (reported live: the
      // period's actual last day, a Sunday, rendered under Monday).
      const original = process.env.TZ;
      process.env.TZ = 'Europe/Amsterdam';
      try {
        const winter = new Date(2027, 0, 4, 0, 0, 0, 0); // Jan 4 - CET, UTC+1
        expect(dateToISO(winter)).toBe('2027-01-04');

        const summer = new Date(2027, 5, 6, 0, 0, 0, 0); // Jun 6 - CEST, UTC+2
        expect(dateToISO(summer)).toBe('2027-06-06');
      } finally {
        process.env.TZ = original;
      }
    });
  });

  describe('Holiday queries', () => {
    it('should find holidays in a date range', () => {
      const holidays = getHolidaysInRange('2024-01-01', '2024-12-31');
      expect(holidays.length).toBeGreaterThan(0);

      const names = holidays.map(h => h.name);
      expect(names).toContain('Nieuwjaarsdag');
      expect(names).toContain('Eerste Kerstdag');
    });

    it('should check if a date is a holiday', () => {
      expect(isHoliday('2024-01-01')).toBe(true); // New Year
      expect(isHoliday('2024-01-02')).toBe(false); // Random Tuesday
      expect(isHoliday('2024-12-25')).toBe(true); // Christmas
    });

    it('should get holiday info for a date', () => {
      const holiday = getHolidayInfo('2024-01-01');
      expect(holiday).not.toBeNull();
      expect(holiday?.name).toBe('Nieuwjaarsdag');
      expect(holiday?.group).toBe('NIEUWJAAR');

      const nonHoliday = getHolidayInfo('2024-01-02');
      expect(nonHoliday).toBeNull();
    });
  });

  describe('Year boundary edge cases', () => {
    it('should handle December 31 correctly (year 2027)', () => {
      // 2027-12-31 is a Friday
      // It should be in week 52 of 2027
      const date = new Date(2027, 11, 31);
      const [year, week] = getISOWeek(date);
      expect(year).toBe(2027);
      expect(week).toBe(52);

      // 2028-01-03 is a Monday and should be in 2028-W01
      // (2028-01-01 is a Saturday, so Jan 1-2 still belong to 2027's last week)
      const date2 = new Date(2028, 0, 3);
      const [year2, week2] = getISOWeek(date2);
      expect(year2).toBe(2028);
      expect(week2).toBe(1);
    });

    it('should handle January 1 spanning years', () => {
      // 2025-01-01 is a Wednesday
      const date = new Date(2025, 0, 1);
      const [year, week] = getISOWeek(date);
      expect(year).toBe(2025);
      // Jan 1 2025 should be in week 1 of 2025
      expect(week).toBe(1);
    });

    it('should handle 53-week years correctly', () => {
      // 2026 has 53 weeks (Jan 1, 2026 is a Thursday)
      const weeksIn2026 = getWeeksInYear(2026);
      expect(weeksIn2026).toBe(53);

      // Dec 31, 2024 rolls over into 2025's week 1, since Dec 31 2024
      // is a Tuesday and the Thursday of its week (Jan 2, 2025) falls
      // in 2025 - this is exactly why getWeeksInYear uses Dec 28, not
      // Dec 31, to compute the true last week of a year.
      const dec31_2024 = new Date(2024, 11, 31);
      const [year, week] = getISOWeek(dec31_2024);
      expect(year).toBe(2025);
      expect(week).toBe(1);
    });
  });
});

/**
 * Every year from 1900 to 2400, held against a second calculation that
 * shares no code with lib/holidays.ts (audit 15): Gauss's Easter
 * algorithm, and the weekday each derived feestdag must fall on. The
 * fixed years above check a dozen dates; this checks five centuries.
 */
describe('feestdagen 1900-2400 against an independent calculation', () => {
  function gaussEaster(year: number): string {
    const a = year % 19;
    const b = year % 4;
    const c = year % 7;
    const k = Math.floor(year / 100);
    const p = Math.floor((13 + 8 * k) / 25);
    const q = Math.floor(k / 4);
    const M = (15 - p + k - q) % 30;
    const N = (4 + k - q) % 7;
    const d = (19 * a + M) % 30;
    const e = (2 * b + 4 * c + 6 * d + N) % 7;
    let offset = 22 + d + e; // days after the last of February: 22 March + d + e
    if (d === 29 && e === 6) offset = 50; // 19 April
    else if (d === 28 && e === 6 && (11 * M + 11) % 30 < 19) offset = 49; // 18 April
    const date = new Date(Date.UTC(year, 2, 1) + (offset - 1) * 86_400_000);
    return date.toISOString().slice(0, 10);
  }
  const plus = (iso: string, days: number) =>
    new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const years = Array.from({ length: 501 }, (_, i) => 1900 + i);

  it('puts Pasen, Hemelvaart and Pinksteren where Gauss does, on the right weekday', () => {
    for (const year of years) {
      const byGroup = (g: string) => getHolidaysForYear(year).filter((h) => h.group === g).map((h) => h.date);
      const easter = gaussEaster(year);
      expect(byGroup('PASEN'), `Pasen ${year}`).toEqual([easter, plus(easter, 1)]);
      expect(weekday(easter), `Eerste Paasdag ${year} on a Sunday`).toBe(0);
      expect(byGroup('HEMELVAART'), `Hemelvaart ${year}`).toEqual([plus(easter, 39)]);
      expect(weekday(plus(easter, 39)), `Hemelvaart ${year} on a Thursday`).toBe(4);
      expect(byGroup('PINKSTEREN'), `Pinksteren ${year}`).toEqual([plus(easter, 49), plus(easter, 50)]);
    }
  });

  it('puts Koningsdag on 27 April, or on the Saturday 26 April when the 27th is a Sunday', () => {
    for (const year of years) {
      const koningsdag = getHolidaysForYear(year).filter((h) => h.group === 'KONINGSDAG').map((h) => h.date);
      const the27th = `${year}-04-27`;
      expect(koningsdag, `Koningsdag ${year}`).toEqual([weekday(the27th) === 0 ? `${year}-04-26` : the27th]);
      expect(weekday(koningsdag[0]), `Koningsdag ${year} never on a Sunday`).not.toBe(0);
    }
  });

  it('gives Bevrijdingsdag every fifth year only, and the fixed days every year', () => {
    for (const year of years) {
      const dates = getHolidaysForYear(year).map((h) => `${h.group}:${h.date}`);
      expect(dates.includes(`BEVRIJDINGSDAG:${year}-05-05`), `Bevrijdingsdag ${year}`).toBe(year % 5 === 0);
      for (const fixed of [`NIEUWJAAR:${year}-01-01`, `KERST:${year}-12-25`, `KERST:${year}-12-26`]) {
        expect(dates, `${fixed}`).toContain(fixed);
      }
      expect(getHolidaysForYear(year).every((h) => h.date.startsWith(`${year}-`))).toBe(true);
    }
  });
});
