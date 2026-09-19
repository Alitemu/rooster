import { describe, it, expect } from 'vitest';
import { isValidIsoDate } from './isoDate';

/**
 * The hard rule: only a real calendar date in YYYY-MM-DD form passes.
 *
 * The interesting cases are the near-misses - a string that matches the
 * shape but is not a date ("2027-02-30") would otherwise be stored, sort
 * plausibly against other dates, and never match anything.
 */

describe('isValidIsoDate', () => {
  it('accepts ordinary dates', () => {
    for (const value of ['2027-01-04', '2000-01-01', '2099-12-31']) {
      expect(isValidIsoDate(value), value).toBe(true);
    }
  });

  it('rejects dates that match the pattern but do not exist', () => {
    // Date() rolls these over rather than failing, so a regex alone would
    // let all of them through.
    for (const value of ['2027-02-30', '2027-13-01', '2027-00-10', '2027-01-32', '2027-04-31']) {
      expect(isValidIsoDate(value), value).toBe(false);
    }
  });

  it('handles the leap-day boundary in both directions', () => {
    expect(isValidIsoDate('2028-02-29')).toBe(true); // leap year
    expect(isValidIsoDate('2027-02-29')).toBe(false); // not a leap year
    expect(isValidIsoDate('2000-02-29')).toBe(true); // divisible by 400
    expect(isValidIsoDate('1900-02-29')).toBe(false); // divisible by 100, not 400
  });

  it('rejects anything that is not exactly the date-only format', () => {
    for (const value of [
      '2027-1-4', // unpadded
      '2027-01-04T00:00:00Z', // full timestamp
      '2027-01-04 ', // trailing space
      '04-01-2027', // Dutch order
      'morgen',
      '',
    ]) {
      expect(isValidIsoDate(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('rejects non-strings', () => {
    for (const value of [null, undefined, 20270104, {}, new Date()]) {
      expect(isValidIsoDate(value), String(value)).toBe(false);
    }
  });
});
