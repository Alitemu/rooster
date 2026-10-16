import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { controleerAiosRooster, REGEL_WOORDEN, type Regel } from '@/lib/aiosRegels';
import type { AiosSolverInvoer } from '@/lib/aiosSolverInvoer';

/**
 * The app's copy of the hard rules (lib/aiosRegels.ts) finds in every
 * roster of tests/fixtures/aios-regels.json exactly what the solver's own
 * check (aios-solver/controle.py) found there; aios-solver/test_gedeeld.py
 * checks controle.py against the same file. A rule changed on one side
 * only fails one of the two.
 */

interface Geval {
  naam: string;
  invoer: AiosSolverInvoer;
  roosters: Array<{ toewijzingen: Array<[string, string]>; fouten: Array<[Regel, string, string[]]> }>;
}

const GEVALLEN = (
  JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/aios-regels.json'), 'utf8')) as { gevallen: Geval[] }
).gevallen;

// Python's sorted() on lists: element by element, a string by code point, a shorter list first.
function vergelijk(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = vergelijk(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  return a === b ? 0 : (a as string) < (b as string) ? -1 : 1;
}

describe('the hard rules, as the solver checks them', () => {
  it('every rule is in the file, and a roster that breaks nothing', () => {
    const gezien = new Set(GEVALLEN.flatMap((g) => g.roosters.flatMap((r) => r.fouten.map((f) => f[0]))));
    expect([...gezien].sort()).toEqual(Object.keys(REGEL_WOORDEN).sort());
    expect(GEVALLEN.some((g) => g.roosters.some((r) => r.fouten.length === 0))).toBe(true);
  });

  for (const geval of GEVALLEN) {
    it(`finds what controle.py found: ${geval.naam}`, () => {
      for (const rooster of geval.roosters) {
        const gevonden = controleerAiosRooster(geval.invoer, new Map(rooster.toewijzingen));
        expect([...gevonden].sort(vergelijk)).toEqual(rooster.fouten);
      }
    });
  }
});
