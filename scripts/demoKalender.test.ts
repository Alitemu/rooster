import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { BASIS_START, verschuifDagen, verschuif } from './demoKalender.mjs';

const DAG = 86_400_000;
const dagVan = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

afterEach(() => {
  delete process.env.DEMO_SHIFT_WEEKS;
});

describe('verschuifDagen', () => {
  it('does not move while the base period starts at least six weeks from now', () => {
    expect(verschuifDagen(new Date(2026, 9, 23))).toBe(0);
    // Exactly six weeks before the base start is still enough.
    expect(verschuifDagen(new Date(2026, 10, 23))).toBe(0);
  });

  it('moves in whole weeks, so the weekday of every date stays', () => {
    for (let dag = 0; dag < 3000; dag += 11) {
      const nu = new Date(2026, 10, 24 + dag);
      const verschil = verschuifDagen(nu);
      expect(verschil % 7).toBe(0);
      expect(dagVan(verschuif(BASIS_START, verschil))).toBe(1); // Monday
    }
  });

  it('always puts the shifted base start at least six weeks and less than seven weeks ahead', () => {
    for (let dag = 0; dag < 3000; dag += 7) {
      const nu = new Date(2026, 10, 24 + dag);
      const vandaag = Date.UTC(nu.getFullYear(), nu.getMonth(), nu.getDate());
      const start = Date.parse(`${verschuif(BASIS_START, verschuifDagen(nu))}T00:00:00Z`);
      const ruimte = (start - vandaag) / DAG;
      expect(ruimte).toBeGreaterThanOrEqual(42);
      expect(ruimte).toBeLessThan(49);
    }
  });

  it('keeps the time of day and the zone of a date-time', () => {
    expect(verschuif('2026-12-15T17:00:00Z', 14)).toBe('2026-12-29T17:00:00Z');
    expect(verschuif('2027-12-20T00:00:00Z', 0)).toBe('2027-12-20T00:00:00Z');
  });

  it('crosses a year boundary and a leap day', () => {
    expect(verschuif('2027-12-27', 14)).toBe('2028-01-10');
    expect(verschuif('2027-02-22', 371)).toBe('2028-02-28');
    expect(verschuif('2028-02-21', 14)).toBe('2028-03-06');
  });

  it('DEMO_SHIFT_WEEKS forces the shift and refuses nonsense', () => {
    process.env.DEMO_SHIFT_WEEKS = '60';
    expect(verschuifDagen(new Date(2026, 9, 23))).toBe(420);
    process.env.DEMO_SHIFT_WEEKS = '-1';
    expect(() => verschuifDagen()).toThrow();
    process.env.DEMO_SHIFT_WEEKS = '1.5';
    expect(() => verschuifDagen()).toThrow();
  });
});

/**
 * The rule these checks exist for: no calendar date in 2026 or 2027 reaches
 * the app as a deadline or period date without going through verschuif().
 * The seed and the e2e fixtures once held 2026-12-15 and 2026-12-31 and would
 * have failed on the calendar alone from December 2026.
 */
describe('the browser checks do not hold a fixed deadline', () => {
  const root = path.resolve(__dirname, '..');
  const bestanden = [
    'scripts/seed.ts',
    'scripts/full-check.mjs',
    'scripts/ui-check.mjs',
    'scripts/scenario-check.mjs',
    'tests/e2e/setup.ts',
    'tests/e2e/fellow.e2e.ts',
    'tests/e2e/dashboard-extras.e2e.ts',
  ];
  // A date in the part of the calendar that is about to pass, as a value that
  // reaches the app: a string literal that is not the argument of verschuif() or demoDatum().
  const LOS = /(?<!verschuif\(|demoDatum\(|ANKER\.|\w)'(20(?:26|27)-\d\d-\d\d(?:T[\d:.]+Z?)?)'/g;

  it.each(bestanden)('%s only holds 2026 and 2027 dates through the shift helper', (rel) => {
    const bron = fs.readFileSync(path.join(root, rel), 'utf-8');
    const regels = bron.split('\n');
    const gevonden: string[] = [];
    regels.forEach((regel, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(regel)) return; // comments say what the base dates are
      for (const m of regel.matchAll(LOS)) {
        // Inside a call of the helper on the same line is fine too.
        if (/verschuif\([^)]*$/.test(regel.slice(0, m.index))) continue;
        if (/demoDatum\([^)]*$/.test(regel.slice(0, m.index))) continue;
        gevonden.push(`${rel}:${i + 1} ${m[1]}`);
      }
    });
    expect(gevonden).toEqual([]);
  });
});

/**
 * The route tests open periods through the real routes, which refuse a
 * deadline in the past. Their `const DEADLINE = '...'` has to lie far enough
 * ahead that this test is the first to say so, a year before it goes off.
 */
describe('the deadline constants of the route tests lie at least a year ahead', () => {
  const root = path.resolve(__dirname, '..');
  function testBestanden(map: string): string[] {
    return fs.readdirSync(map, { withFileTypes: true }).flatMap((e) => {
      const volledig = path.join(map, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : testBestanden(volledig);
      return e.name.endsWith('.test.ts') ? [volledig] : [];
    });
  }
  it('every const DEADLINE', () => {
    const grens = Date.now() + 365 * DAG;
    const te_vroeg: string[] = [];
    let gezien = 0;
    for (const bestand of [...testBestanden(path.join(root, 'app')), ...testBestanden(path.join(root, 'lib'))]) {
      const bron = fs.readFileSync(bestand, 'utf-8');
      for (const m of bron.matchAll(/const DEADLINE = '(\d{4}-\d\d-\d\d)/g)) {
        gezien++;
        if (Date.parse(`${m[1]}T00:00:00Z`) < grens) te_vroeg.push(`${path.relative(root, bestand)} ${m[1]}`);
      }
    }
    expect(gezien).toBeGreaterThan(0);
    expect(te_vroeg).toEqual([]);
  });
});
