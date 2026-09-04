import { describe, it, expect } from 'vitest';
import { buildMonthGroups } from './calendarMonths';

describe('buildMonthGroups', () => {
  it('starts a month exactly on its 1st and ends exactly on its last day', () => {
    // 2027-04-01 is a Thursday, 2027-04-30 is a Friday - the user's own
    // example of what "zuiver ingedeeld per maand" should look like.
    const groups = buildMonthGroups(new Date(2027, 2, 1), new Date(2027, 4, 31));
    const april = groups.find((g) => g.label.startsWith('april'))!;
    expect(april).toBeDefined();

    const allDays = april.weeks.flatMap((w) => w.days);
    const realDays = allDays.filter((d): d is string => d !== null);

    expect(realDays[0]).toBe('2027-04-01');
    expect(realDays[realDays.length - 1]).toBe('2027-04-30');
    expect(realDays).toHaveLength(30);
    // No day from March or May leaked into April's grid.
    expect(realDays.every((d) => d.startsWith('2027-04'))).toBe(true);
  });

  it('never shows the same date in two different month groups', () => {
    const groups = buildMonthGroups(new Date(2027, 0, 4), new Date(2027, 5, 6));
    const seen = new Set<string>();
    for (const group of groups) {
      for (const week of group.weeks) {
        for (const day of week.days) {
          if (day === null) continue;
          expect(seen.has(day)).toBe(false);
          seen.add(day);
        }
      }
    }
  });

  it('leaves leading/trailing cells in a partial week as null instead of a neighbor month date', () => {
    const groups = buildMonthGroups(new Date(2027, 2, 1), new Date(2027, 4, 31));
    const april = groups.find((g) => g.label.startsWith('april'))!;
    const firstRow = april.weeks[0];
    // April 1 2027 is a Thursday: Mon/Tue/Wed of that row belong to March
    // and must be blank, not silently filled with March's dates.
    expect(firstRow.days[0]).toBeNull();
    expect(firstRow.days[1]).toBeNull();
    expect(firstRow.days[2]).toBeNull();
    expect(firstRow.days[3]).toBe('2027-04-01');

    const lastRow = april.weeks[april.weeks.length - 1];
    // April 30 2027 is a Friday: Sat/Sun of that row belong to May.
    expect(lastRow.days[4]).toBe('2027-04-30');
    expect(lastRow.days[5]).toBeNull();
    expect(lastRow.days[6]).toBeNull();
  });

  it('covers the full requested range across all groups with no gaps or duplicates', () => {
    const start = new Date(2027, 0, 4);
    const end = new Date(2027, 5, 6);
    const groups = buildMonthGroups(start, end);
    const realDays = groups.flatMap((g) => g.weeks.flatMap((w) => w.days)).filter((d): d is string => d !== null);

    const totalDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    expect(realDays).toHaveLength(totalDays);
  });
});
