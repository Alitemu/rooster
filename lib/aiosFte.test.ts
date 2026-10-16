import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { aiosFte, aiosWerkdagen, dienstpercentage } from './aiosFte';

/**
 * The rules (docs/aios-rooster.md, "Eerlijkheid"):
 * - one part-time day every week is 0,8, every other week 0,9, none 1,0; a
 *   pattern for part of the quarter counts pro rata;
 * - werkdagen are Monday to Friday without feestdagen, within Geldig
 *   vanaf/tot, outside an onderbreking (leave is an ordinary werkdag);
 * - dienstpercentage = punten / (werkdagen x fte).
 * The AIOS's solver counts the werkdagen the same (aios-solver/model.py).
 */

// 2097 Q1: Wednesday 2 January to Tuesday 2 April, 13 weeks.
const VAN = '2097-01-02';
const TOT = '2097-04-02';
const heel = (frequentie: 'ELKE_WEEK' | 'EVEN_WEKEN' | 'ONEVEN_WEKEN') => ({ frequentie, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });

describe('the fte from the part-time days', () => {
  it('is 1,0 without, 0,8 for a day every week and 0,9 for a day every other week', () => {
    expect(aiosFte([], VAN, TOT)).toBe(1);
    expect(aiosFte([heel('ELKE_WEEK')], VAN, TOT)).toBe(0.8);
    expect(aiosFte([heel('EVEN_WEKEN')], VAN, TOT)).toBe(0.9);
    expect(aiosFte([heel('ONEVEN_WEKEN')], VAN, TOT)).toBe(0.9);
    expect(aiosFte([heel('ELKE_WEEK'), heel('ELKE_WEEK')], VAN, TOT)).toBe(0.6);
  });

  it('counts a pattern for part of the quarter pro rata, and one outside it not at all', () => {
    // Half the quarter: 0,9 instead of 0,8.
    const helft = { frequentie: 'ELKE_WEEK' as const, geldig_vanaf: '2097-02-16', geldig_tot: '2099-12-31' };
    expect(aiosFte([helft], VAN, TOT)).toBe(0.9);
    expect(aiosFte([{ ...helft, geldig_vanaf: '2098-01-01' }], VAN, TOT)).toBe(1);
  });

  it('stays between 0,2 and 1 whatever the patterns', () => {
    const patroon = fc.record({
      frequentie: fc.constantFrom('ELKE_WEEK' as const, 'EVEN_WEKEN' as const, 'ONEVEN_WEKEN' as const),
      geldig_vanaf: fc.constantFrom('2096-12-01', '2097-01-20', '2097-03-01'),
      geldig_tot: fc.constantFrom('2097-01-31', '2097-03-15', '2099-12-31'),
    });
    fc.assert(
      fc.property(fc.array(patroon, { maxLength: 6 }), (patronen) => {
        const fte = aiosFte(patronen, VAN, TOT);
        expect(fte).toBeGreaterThanOrEqual(0.2);
        expect(fte).toBeLessThanOrEqual(1);
      })
    );
  });
});

describe('the werkdagen and the dienstpercentage', () => {
  const heelKwartaal = { beschikbaar: [{ van: VAN, tot: TOT }], onderbreking: null };

  it('counts Monday to Friday without feestdagen', () => {
    // 13 weeks of 5 werkdagen, less the one feestdag on a Friday.
    expect(aiosWerkdagen(heelKwartaal, VAN, TOT, new Set())).toBe(65);
    expect(aiosWerkdagen(heelKwartaal, VAN, TOT, new Set(['2097-01-04', '2097-01-05']))).toBe(64);
  });

  it('leaves out the days outside Geldig vanaf/tot and during an onderbreking', () => {
    expect(aiosWerkdagen({ beschikbaar: [{ van: VAN, tot: '2097-01-08' }], onderbreking: null }, VAN, TOT, new Set())).toBe(5);
    expect(aiosWerkdagen({ ...heelKwartaal, onderbreking: { van: '2097-01-07', tot: '2097-01-13' } }, VAN, TOT, new Set())).toBe(60);
  });

  it('is punten / (werkdagen x fte), and none without werkdagen', () => {
    // One night a week at 0,8 fte: 25% (C4).
    expect(dienstpercentage(13, 65, 0.8)).toBeCloseTo(0.25);
    expect(dienstpercentage(13, 65, 1)).toBeCloseTo(0.2);
    expect(dienstpercentage(3, 0, 0.8)).toBeNull();
  });
});
