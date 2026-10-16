import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { addDays } from '@/lib/holidays';
import { oudjaarIn, reeksen } from '@/lib/aiosFeestdagBlokken';

/**
 * Which feestdagen are "in a row" (reeksen: a question per block, no
 * default) and whether 31 December falls in a period (oudjaarIn: the
 * second AIOS on the night).
 */

describe('feestdagen in a row', () => {
  it('joins consecutive days, also over a month and a year', () => {
    expect(reeksen(['2096-04-15', '2096-04-16', '2096-04-27'])).toEqual([['2096-04-15', '2096-04-16'], ['2096-04-27']]);
    expect(reeksen(['2096-12-31', '2097-01-01'])).toEqual([['2096-12-31', '2097-01-01']]);
    expect(reeksen(['2096-05-31', '2096-06-01'])).toEqual([['2096-05-31', '2096-06-01']]);
    expect(reeksen(['2096-12-25', '2096-12-27'])).toEqual([['2096-12-25'], ['2096-12-27']]);
    expect(reeksen([])).toEqual([]);
  });

  it('every day once, in order, and a break between two runs', () => {
    const datum = fc.integer({ min: 0, max: 400 }).map((n) => addDays('2096-11-01', n));
    fc.assert(
      fc.property(fc.array(datum, { maxLength: 30 }), (datums) => {
        const uit = reeksen(datums);
        expect(uit.flat()).toEqual([...new Set(datums)].sort());
        for (const run of uit) for (let i = 1; i < run.length; i++) expect(run[i]).toBe(addDays(run[i - 1], 1));
        for (let i = 1; i < uit.length; i++) expect(uit[i][0] > addDays(uit[i - 1][uit[i - 1].length - 1], 1)).toBe(true);
      })
    );
  });
});

describe('31 December in the period', () => {
  it('in the quarter to early January, not in the one after or before', () => {
    expect(oudjaarIn({ start_datum: '2096-10-03', eind_datum: '2097-01-01' })).toBe('2096-12-31');
    expect(oudjaarIn({ start_datum: '2097-01-02', eind_datum: '2097-04-02' })).toBeNull();
    expect(oudjaarIn({ start_datum: '2096-07-04', eind_datum: '2096-10-02' })).toBeNull();
  });

  it('on the first or the last day too', () => {
    expect(oudjaarIn({ start_datum: '2096-12-31', eind_datum: '2097-03-31' })).toBe('2096-12-31');
    expect(oudjaarIn({ start_datum: '2096-10-01', eind_datum: '2096-12-31' })).toBe('2096-12-31');
    expect(oudjaarIn({ start_datum: '2097-01-01', eind_datum: '2097-03-31' })).toBeNull();
  });
});
