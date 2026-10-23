import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'fs';
import path from 'path';
import { localIsoMinute, localIsoDate } from './localDate';

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

describe('localIsoMinute', () => {
  it('is the ward clock as a deadline is written, in summer and in winter', () => {
    expect(localIsoMinute(new Date('2026-12-01T16:00:00Z'))).toBe('2026-12-01T17:00');
    expect(localIsoMinute(new Date('2026-07-01T15:00:00Z'))).toBe('2026-07-01T17:00');
    // Midnight is 00:00, not 24:00.
    expect(localIsoMinute(new Date('2026-12-01T23:00:00Z'))).toBe('2026-12-02T00:00');
  });

  it('does not depend on the clock of the machine', () => {
    const bewaard = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Europe/Amsterdam']) {
        process.env.TZ = tz;
        expect(localIsoMinute(new Date('2026-10-24T23:30:00Z')), tz).toBe('2026-10-25T01:30');
        expect(localIsoDate(new Date('2026-10-24T23:30:00Z')), tz).toBe('2026-10-25');
      }
    } finally {
      process.env.TZ = bewaard;
    }
  });
});

describe('nobody works out today in UTC', () => {
  // Static, over the app and everything that checks it: audit 10 found the
  // e2e test for "Personeel beheren" doing what audit 9 took out of the page
  // itself, and failing at 00:47 Dutch time while the page was right.
  it('no new Date().toISOString() cut to a date outside lib/localDate.ts', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(tsx?|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []
      );
    const todayInUtc = /new Date\(\)\.toISOString\(\)\.(slice\(0, ?10\)|split\('T'\)\[0\]|substring\(0, ?10\))/;
    const offenders = ['app', 'lib', 'components', 'tests', 'scripts']
      .flatMap((d) => walk(path.join(process.cwd(), d)))
      .filter((f) => !f.endsWith(path.join('lib', 'localDate.ts')) && !f.endsWith(path.join('lib', 'localDate.test.ts')))
      .filter((f) => todayInUtc.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });

  // The same, with the machine's own calendar: the date built from getFullYear, getMonth and getDate.
  it('no date built from the getters of a Date outside lib/localDate.ts, unless it is not about today', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(tsx?|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []
      );
    const lokaleDatum = /\$\{\w+\.getFullYear\(\)\}-\$\{pad\(\w+\.getMonth\(\) \+ 1\)\}-\$\{pad\(\w+\.getDate\(\)\)\}/;
    // Not about today: a deadline written into a datetime-local input is formatted from a stored moment.
    const toegestaan = [path.join('app', 'planner', 'period', '[id]', 'page.tsx')];
    const offenders = ['app', 'lib', 'components', 'scripts']
      .flatMap((d) => walk(path.join(process.cwd(), d)))
      .filter((f) => !/\.test\.tsx?$/.test(f) && !f.endsWith(path.join('lib', 'localDate.ts')))
      .filter((f) => !toegestaan.some((t) => f.endsWith(t)))
      .filter((f) => lokaleDatum.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });

  // A date alone is read as UTC midnight: shown on a machine west of UTC it is the day before.
  it('no day shown from `new Date(<date>)` without a time of day', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(tsx?|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []
      );
    const zonderTijd = /new Date\((?:\w+\.)*(?:datum|start_datum|eind_datum|van_datum|tot_datum)\)\.toLocale/;
    const offenders = ['app', 'lib', 'components']
      .flatMap((d) => walk(path.join(process.cwd(), d)))
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => zonderTijd.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });
});
