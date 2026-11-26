import { describe, it, expect } from 'vitest';
import { isPlausibleIsoDate, isValidIsoDate, parseDutchOrIsoDate, parseSheetDate } from './isoDate';

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

describe('parseSheetDate', () => {
  // 0.20.0: the downloads write real dates, which a workbook holds as
  // Excel's day number; the imports that read them back get that number.
  it('reads the day number of a workbook date cell, and text as parseDutchOrIsoDate does', () => {
    expect(parseSheetDate('46391')).toBe('2027-01-04');
    expect(parseSheetDate('46387')).toBe('2026-12-31');
    expect(parseSheetDate('46812.0')).toBe('2028-02-29');
    expect(parseSheetDate('4-1-2027')).toBe('2027-01-04');
    expect(parseSheetDate('2027-01-04')).toBe('2027-01-04');
  });

  it('takes no other number for a date', () => {
    for (const value of ['53', '2027', '46391.5', '-46391', '463910', '']) expect(parseSheetDate(value)).toBeNull();
  });
});

describe('parseDutchOrIsoDate', () => {
  // Audit 12: a file this app exported and a Dutch Excel saved again
  // holds its dates as d-m-yyyy.
  it('reads ISO and the way a Dutch Excel writes a date back', () => {
    expect(parseDutchOrIsoDate('2027-01-04')).toBe('2027-01-04');
    expect(parseDutchOrIsoDate('4-1-2027')).toBe('2027-01-04');
    expect(parseDutchOrIsoDate('04-01-2027')).toBe('2027-01-04');
    expect(parseDutchOrIsoDate('4/1/2027')).toBe('2027-01-04');
    expect(parseDutchOrIsoDate(' 31.12.2026 ')).toBe('2026-12-31');
  });

  it('only real calendar dates', () => {
    expect(parseDutchOrIsoDate('29-2-2028')).toBe('2028-02-29');
    expect(parseDutchOrIsoDate('29-2-2027')).toBeNull();
    expect(parseDutchOrIsoDate('31-4-2027')).toBeNull();
    expect(parseDutchOrIsoDate('1-13-2027')).toBeNull();
    expect(parseDutchOrIsoDate('2027')).toBeNull();
    expect(parseDutchOrIsoDate('')).toBeNull();
  });
});

describe('isPlausibleIsoDate', () => {
  it('takes the years a roster can concern and nothing outside them', () => {
    for (const ok of ['2000-01-01', '2026-10-22', '2199-12-31']) expect(isPlausibleIsoDate(ok), ok).toBe(true);
    for (const nee of ['1999-12-31', '1000-01-01', '2200-01-01', '9999-12-31', '2027-02-30', 'x', 20270101, null]) {
      expect(isPlausibleIsoDate(nee), String(nee)).toBe(false);
    }
  });
});
