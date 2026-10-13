import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { localIsoDate } from './localDate';

/**
 * The rule: "today" is the date on a Dutch calendar, not in UTC.
 */

describe('localIsoDate', () => {
  it('just after midnight Dutch time is already the next day, in summer and in winter', () => {
    expect(localIsoDate(new Date('2026-10-13T22:30:00Z'))).toBe('2026-10-14'); // CEST, UTC+2
    expect(localIsoDate(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01'); // CET, UTC+1
  });

  it('just before midnight Dutch time is still that day', () => {
    expect(localIsoDate(new Date('2026-10-13T21:59:00Z'))).toBe('2026-10-13');
    expect(localIsoDate(new Date('2026-12-31T22:59:00Z'))).toBe('2026-12-31');
  });

  it('on the nights the clocks change', () => {
    expect(localIsoDate(new Date('2027-03-28T00:30:00Z'))).toBe('2027-03-28'); // 01:30 CET, before the change
    expect(localIsoDate(new Date('2027-10-30T22:30:00Z'))).toBe('2027-10-31'); // 00:30 CEST
  });

  it('is always one or two hours ahead of the UTC date, never behind', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2040-12-31T00:00:00Z'), noInvalidDate: true }), (at) => {
        const local = localIsoDate(at);
        const utc = at.toISOString().slice(0, 10);
        const twoHoursOn = new Date(at.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
        expect(local === utc || local === twoHoursOn).toBe(true);
        expect(local).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      })
    );
  });
});
