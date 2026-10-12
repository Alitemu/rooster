import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  getHolidaysForYear,
  getISOWeek,
  getWeekRange,
  getWeeksInYear,
  countWeeksBetween,
  roundToMonday,
  roundToSunday,
  addDays,
  parseISO,
  dateToISO,
} from './holidays';
import { reminderMoment, REMINDER_HOUR } from './autoReminders';
import { resolvePeriodBands, scaledBandForMember, fellowWeekendBand, type Teller } from './rosterBands';

/**
 * The calendar the roster is built on, checked against independent
 * definitions rather than against itself: Easter by Gauss's method instead
 * of the Meeus one the app uses, ISO weeks by their Thursday rule, and every
 * date helper across all the daylight-saving changes of the next decades
 * (tests run in Europe/Amsterdam, see tests/globalSetup.ts).
 */

/** Easter Sunday by Gauss's algorithm - a different route to the same date. */
function gaussEaster(y: number): string {
  const a = y % 19;
  const b = y % 4;
  const c = y % 7;
  const k = Math.floor(y / 100);
  const p = Math.floor((13 + 8 * k) / 25);
  const q = Math.floor(k / 4);
  const M = (15 - p + k - q) % 30;
  const N = (4 + k - q) % 7;
  const d = (19 * a + M) % 30;
  const e = (2 * b + 4 * c + 6 * d + N) % 7;
  let month = 3;
  let day = 22 + d + e;
  if (day > 31) {
    month = 4;
    day = d + e - 9;
  }
  if (month === 4 && day === 26) day = 19;
  if (month === 4 && day === 25 && d === 28 && e === 6 && a > 10) day = 18;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const weekday = (iso: string) => parseISO(iso).getDay();
const year = fc.integer({ min: 1900, max: 2200 });

describe('feestdagen', () => {
  it('Easter agrees with an independent method, every year', () => {
    for (let y = 1900; y <= 2400; y++) {
      const pasen = getHolidaysForYear(y).filter((h) => h.group === 'PASEN').map((h) => h.date);
      expect(pasen[0], String(y)).toBe(gaussEaster(y));
    }
  });

  it('each lands on the weekday it must', () => {
    fc.assert(
      fc.property(year, (y) => {
        const by = (g: string) => getHolidaysForYear(y).filter((h) => h.group === g).map((h) => h.date);
        const [pasen1, pasen2] = by('PASEN');
        expect([weekday(pasen1), weekday(pasen2)]).toEqual([0, 1]);
        expect(addDays(pasen1, 1)).toBe(pasen2);
        expect(weekday(by('HEMELVAART')[0])).toBe(4);
        expect(by('HEMELVAART')[0]).toBe(addDays(pasen1, 39));
        expect(by('PINKSTEREN')).toEqual([addDays(pasen1, 49), addDays(pasen1, 50)]);
        const koningsdag = by('KONINGSDAG')[0];
        expect(weekday(koningsdag)).not.toBe(0);
        expect(koningsdag === `${y}-04-27` || (koningsdag === `${y}-04-26` && weekday(`${y}-04-27`) === 0)).toBe(true);
        expect(by('BEVRIJDINGSDAG')).toEqual(y % 5 === 0 ? [`${y}-05-05`] : []);
        expect(by('NIEUWJAAR')).toEqual([`${y}-01-01`]);
        expect(by('KERST')).toEqual([`${y}-12-25`, `${y}-12-26`]);
      }),
      { numRuns: 301 }
    );
  });

  it('are in date order without doubles, inside their own year', () => {
    fc.assert(
      fc.property(year, (y) => {
        const holidays = getHolidaysForYear(y);
        const dates = holidays.map((h) => h.date);
        expect(dates).toEqual([...dates].sort());
        expect(new Set(holidays.map((h) => `${h.date}|${h.group}`)).size).toBe(holidays.length);
        for (const d of dates) expect(d.startsWith(`${y}-`)).toBe(true);
        // Two on one day only when Hemelvaart falls on a lustrum's 5 May
        // (Easter on 27 March: 2005, next in 2157).
        const doubles = dates.filter((d, i) => dates.indexOf(d) !== i);
        for (const d of doubles) {
          expect(holidays.filter((h) => h.date === d).map((h) => h.group).sort()).toEqual(['BEVRIJDINGSDAG', 'HEMELVAART']);
        }
      }),
      { examples: [[2005]] }
    );
  });
});

// Every day from 1990 to 2060, as YYYY-MM-DD.
const isoDay = fc.integer({ min: 0, max: 70 * 366 }).map((n) => addDays('1990-01-01', n));

describe('ISO weeks', () => {
  /** The ISO week by its definition: the week holding that week's Thursday, counted from the year's first Thursday. */
  function isoWeekByDefinition(iso: string): [number, number] {
    const d = parseISO(iso);
    const dow = d.getDay() || 7;
    const thursday = addDays(iso, 4 - dow);
    const y = parseISO(thursday).getFullYear();
    const jan1 = `${y}-01-01`;
    const firstThursday = addDays(jan1, (4 - (weekday(jan1) || 7) + 7) % 7);
    const days = Math.round((Date.UTC(...ymd(thursday)) - Date.UTC(...ymd(firstThursday))) / 86400000);
    return [y, days / 7 + 1];
  }
  function ymd(iso: string): [number, number, number] {
    const [y, m, d] = iso.split('-').map(Number);
    return [y, m - 1, d];
  }

  it('getISOWeek follows the Thursday rule on every day, summer time included', () => {
    fc.assert(
      fc.property(isoDay, fc.integer({ min: 0, max: 23 }), (iso, hour) => {
        const d = parseISO(iso);
        d.setHours(hour);
        expect(getISOWeek(d)).toEqual(isoWeekByDefinition(iso));
      }),
      { numRuns: 3000 }
    );
  });

  it('getWeekRange gives that week, Monday to Sunday', () => {
    fc.assert(
      fc.property(isoDay, (iso) => {
        const [y, w] = getISOWeek(parseISO(iso));
        const [monday, sunday] = getWeekRange(y, w);
        expect(weekday(monday)).toBe(1);
        expect(sunday).toBe(addDays(monday, 6));
        expect(iso >= monday && iso <= sunday).toBe(true);
      }),
      { numRuns: 2000 }
    );
  });

  it('a year has 52 or 53 weeks, and counting weeks matches counting days', () => {
    fc.assert(
      fc.property(isoDay, fc.integer({ min: 0, max: 400 }), (iso, weeks) => {
        const later = addDays(iso, weeks * 7);
        const [y1, w1] = getISOWeek(parseISO(iso));
        const [y2, w2] = getISOWeek(parseISO(later));
        expect([52, 53]).toContain(getWeeksInYear(y1));
        expect(countWeeksBetween(y1, w1, y2, w2)).toBe(weeks + 1);
      }),
      { numRuns: 1000 }
    );
  });

  it('rounding to Monday and Sunday stays in the same week, at any hour', () => {
    fc.assert(
      fc.property(isoDay, fc.integer({ min: 0, max: 23 }), (iso, hour) => {
        const d = parseISO(iso);
        d.setHours(hour, 30);
        const monday = dateToISO(roundToMonday(d));
        const sunday = dateToISO(roundToSunday(d));
        expect(weekday(monday)).toBe(1);
        expect(weekday(sunday)).toBe(0);
        expect(monday <= iso && iso <= sunday).toBe(true);
        expect(sunday).toBe(addDays(monday, 6));
      }),
      { numRuns: 2000 }
    );
  });

  it('addDays moves by calendar days across every clock change', () => {
    fc.assert(
      fc.property(isoDay, fc.integer({ min: -400, max: 400 }), (iso, n) => {
        const moved = addDays(iso, n);
        const days = Math.round((Date.UTC(...ymd(moved)) - Date.UTC(...ymd(iso))) / 86400000);
        expect(days).toBe(n);
        expect(addDays(moved, -n)).toBe(iso);
      }),
      { numRuns: 3000 }
    );
  });
});

describe('reminder moments', () => {
  it('are the last 09:00 at least that many whole days before the deadline, around clock changes too', () => {
    const start = new Date('2026-01-01T00:00:00Z').getTime();
    const end = new Date('2036-01-01T00:00:00Z').getTime();
    fc.assert(
      fc.property(fc.integer({ min: start, max: end }), fc.integer({ min: 1, max: 14 }), (ms, dagen) => {
        const deadline = new Date(ms);
        const latest = deadline.getTime() - dagen * 86400000;
        const moment = reminderMoment(deadline, dagen);
        expect([moment.getHours(), moment.getMinutes(), moment.getSeconds()]).toEqual([REMINDER_HOUR, 0, 0]);
        expect(moment.getTime()).toBeLessThanOrEqual(latest);
        const next = new Date(moment);
        next.setDate(next.getDate() + 1);
        expect(next.getTime()).toBeGreaterThan(latest);
      }),
      { numRuns: 5000 }
    );
  });
});

describe('streefbereik: the targets leave room for every shift', () => {
  const teller: Teller = 'AVOND';
  const period = { start_datum: '2027-01-04', eind_datum: '2027-06-06' };
  const full = { deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2099-12-31' };
  type M = typeof full;

  function room(slots: number, members: M[], mode = 'GELIJK') {
    const withIds = members.map((m, i) => ({ ...m, id: `p${i}` }));
    const bands = resolvePeriodBands({}, { AVOND: slots, WEEKEND: 0, FEESTDAG: 0 }, withIds, new Set(), period, mode);
    const scaled = members.map((m) => scaledBandForMember(bands, teller, m, period, mode));
    return {
      scaled,
      minSum: scaled.reduce((s, [min]) => s + min, 0),
      maxSum: scaled.reduce((s, [, max]) => s + max, 0),
    };
  }

  // Joining from 1 March, leaving end of March, or both halves: every
  // combination of membership window and deelnamefactor.
  // Only real memberships that overlap the period: the ones the queries select.
  const member = fc
    .record({
      deelnamefactor: fc.constantFrom(1, 1, 0.8, 0.5, 0.25),
      geldig_vanaf: fc.constantFrom('2020-01-01', '2027-03-01', '2027-04-19'),
      geldig_tot: fc.constantFrom('2099-12-31', '2027-03-31', '2027-05-09'),
    })
    .filter((m) => m.geldig_vanaf <= m.geldig_tot);

  it('for any pool: the minimums together fit, the maximums together cover every shift', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 }), fc.array(member, { minLength: 1, maxLength: 40 }), fc.constantFrom('GELIJK', 'NAAR_RATO'), (slots, members, mode) => {
        const { minSum, maxSum, scaled } = room(slots, members, mode);
        for (const [min, max] of scaled) expect(0 <= min && min <= max).toBe(true);
        expect(minSum).toBeLessThanOrEqual(slots);
        expect(maxSum).toBeGreaterThanOrEqual(slots);
      }),
      { numRuns: 2000 }
    );
  });

  it('with fellows: the others alone still cover every weekend shift, and a fellow never gets more than they released', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 120 }), fc.integer({ min: 2, max: 40 }), fc.nat(), fc.nat(30), (weekend, people, f, released) => {
        const fellows = f % people;
        const members = Array.from({ length: people }, (_, i) => ({ ...full, id: `p${i}` }));
        const fellowIds = new Set(members.slice(0, fellows).map((m) => m.id));
        const bands = resolvePeriodBands({}, { AVOND: 0, WEEKEND: weekend, FEESTDAG: 0 }, members, fellowIds, period, 'GELIJK');
        const [min, max] = bands.WEEKEND;
        expect(min * (people - fellows)).toBeLessThanOrEqual(weekend);
        expect(max * (people - fellows)).toBeGreaterThanOrEqual(weekend);
        const own = fellowWeekendBand(bands.WEEKEND, released);
        expect(own[0]).toBe(0);
        expect(own[1]).toBeLessThanOrEqual(Math.min(released, max));
      })
    );
  });

  // Audit 6: the band was worked out over the headcount, while someone who
  // joined or left halfway (or, NAAR_RATO, a part-timer) got a lower
  // maximum, so the maximums together fell short: 30 people, 110
  // avonddiensten, 6 of them half the period - bereik 3 of 4, maximums
  // 108, and the solver left 2 shifts empty.
  it('also with people who join or leave halfway', () => {
    const half = { deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2027-03-21' };
    const { maxSum } = room(110, [...Array(24).fill(full), ...Array(6).fill(half)]);
    expect(maxSum).toBeGreaterThanOrEqual(110);
  });

  it('also with part-timers when the shifts are shared naar rato', () => {
    const part = { ...full, deelnamefactor: 0.5 };
    const { maxSum } = room(110, [...Array(24).fill(full), ...Array(6).fill(part)], 'NAAR_RATO');
    expect(maxSum).toBeGreaterThanOrEqual(110);
  });
});
