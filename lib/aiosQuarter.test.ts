import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { addDays, parseISO } from './holidays';
import {
  aiosPreferenceDeadline,
  aiosQuartersToOffer,
  aiosQuarter,
  aiosQuarterContaining,
  aiosQuarterName,
  aiosQuarterWeeks,
  exactAiosQuarter,
  nextAiosQuarter,
  KWARTALEN,
} from './aiosQuarter';

/**
 * The rule (docs/aios-rooster.md, "Periode"): a quarter runs from a
 * Wednesday to a Tuesday; Q1 starts on the first Wednesday after 1 January
 * (8 January when 1 January is a Wednesday), Q2 and Q3 13 weeks later each,
 * and Q4 runs to the day before the next Q1. The quarters of all years
 * follow each other without a gap or an overlap.
 */

const weekdag = (datum: string) => parseISO(datum).getDay();

describe('the AIOS quarter', () => {
  it('starts Q1 on the first Wednesday after 1 January, as the old form did', () => {
    expect(aiosQuarter(2026, 1).start_datum).toBe('2026-01-07'); // 1 January a Thursday
    expect(aiosQuarter(2027, 1).start_datum).toBe('2027-01-06'); // the first period in the app
    expect(aiosQuarter(2029, 1).start_datum).toBe('2029-01-03'); // a Monday
    expect(aiosQuarter(2030, 1).start_datum).toBe('2030-01-02'); // a Tuesday
    // 1 January itself a Wednesday: not that day, the one a week later.
    expect(aiosQuarter(2025, 1).start_datum).toBe('2025-01-08');
    expect(aiosQuarter(2031, 1).start_datum).toBe('2031-01-08');
  });

  it('gives the quarter of the old form for Q3 2026', () => {
    expect(aiosQuarter(2026, 3)).toEqual({ jaar: 2026, kwartaal: 3, start_datum: '2026-07-08', eind_datum: '2026-10-06' });
    expect(aiosQuarterName(aiosQuarter(2026, 3))).toBe('2026 Q3');
  });

  // The old form ended Q4 2029 on 8 January 2030 while Q1 2030 began on
  // the 2nd: a week in two quarters.
  it('ends Q4 the day before the next Q1, also where the old form overlapped them', () => {
    expect(aiosQuarter(2029, 4).eind_datum).toBe('2030-01-01');
    expect(aiosQuarterWeeks(aiosQuarter(2029, 4))).toBe(13);
    // And Q4 2030 gets the extra week, as 1 January 2031 is a Wednesday.
    expect(aiosQuarter(2030, 4).eind_datum).toBe('2031-01-07');
    expect(aiosQuarterWeeks(aiosQuarter(2030, 4))).toBe(14);
  });

  it('tiles every year from Wednesday to Tuesday, without a gap or an overlap', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 2100 }), (jaar) => {
        for (const k of KWARTALEN) {
          const q = aiosQuarter(jaar, k);
          expect(weekdag(q.start_datum)).toBe(3);
          expect(weekdag(q.eind_datum)).toBe(2);
          if (k === 4) expect([13, 14]).toContain(aiosQuarterWeeks(q));
          else expect(aiosQuarterWeeks(q)).toBe(13);
          expect(addDays(q.eind_datum, 1)).toBe(nextAiosQuarter(q).start_datum);
        }
      })
    );
  });

  it('finds the quarter a date falls in', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date(2001, 0, 1), max: new Date(2099, 11, 31), noInvalidDate: true }), (d) => {
        const datum = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const q = aiosQuarterContaining(datum);
        expect(q.start_datum <= datum && datum <= q.eind_datum).toBe(true);
      })
    );
    // 1 January 2030 is still in Q4 2029.
    expect(aiosQuarterContaining('2030-01-01')).toMatchObject({ jaar: 2029, kwartaal: 4 });
  });

  // The quarter running has started: its deadline would lie in the past,
  // so offering it only led to a refusal (AIOS audit).
  it('offers the quarters that have not started yet, the next one first', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date(2001, 0, 1), max: new Date(2099, 11, 31), noInvalidDate: true }), (d) => {
        const vandaag = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const lijst = aiosQuartersToOffer(vandaag);
        expect(lijst).toHaveLength(6);
        expect(lijst[0].start_datum > vandaag).toBe(true);
        expect(lijst[0]).toEqual(nextAiosQuarter(aiosQuarterContaining(vandaag)));
      })
    );
    expect(aiosQuartersToOffer('2026-10-15').map(aiosQuarterName)).toEqual(['2027 Q1', '2027 Q2', '2027 Q3', '2027 Q4', '2028 Q1', '2028 Q2']);
    // 8 weeks before 6 January 2027.
    expect(aiosPreferenceDeadline(aiosQuarter(2027, 1))).toBe('2026-11-11');
  });

  it('knows a period that is exactly one quarter, and only that', () => {
    expect(exactAiosQuarter('2027-01-06', '2027-04-06')).toMatchObject({ jaar: 2027, kwartaal: 1 });
    expect(exactAiosQuarter('2026-10-07', '2027-01-05')).toMatchObject({ jaar: 2026, kwartaal: 4 });
    expect(exactAiosQuarter('2027-01-06', '2027-04-05')).toBeNull();
    expect(exactAiosQuarter('2027-01-07', '2027-04-06')).toBeNull();
    // Two quarters together are no quarter.
    expect(exactAiosQuarter('2027-01-06', '2027-07-06')).toBeNull();
  });
});
