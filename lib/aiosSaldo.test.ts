import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { aiosSaldoWoorden, beginstandPunten, beginstandSaldi, type Beginstand } from '@/lib/aiosSaldo';

/**
 * The history from before the app as a saldo (lib/aiosSaldo.ts): against
 * the average per fte x maanden of everyone read in, so whoever did more
 * gets fewer; what one did too much, others did too little; and always in
 * words, never a signed number.
 */

const rij = (person_id: string, w: Partial<Beginstand> = {}): Beginstand => ({
  person_id,
  nachten: 10,
  avonden: 10,
  avonden_weekend: 5,
  dagdiensten: 5,
  uitloopdiensten: 10,
  feestdagdiensten: 2,
  fte: 1,
  maanden: 12,
  ...w,
});

describe('the points of the old Excel', () => {
  it('a night, a dagdienst and an evening at the weekend a point; an evening in the week 0,6; an uitloopdienst 0,2', () => {
    expect(beginstandPunten({ nachten: 1, avonden: 0, avonden_weekend: 0, dagdiensten: 0, uitloopdiensten: 0 })).toBe(1);
    expect(beginstandPunten({ nachten: 0, avonden: 5, avonden_weekend: 0, dagdiensten: 0, uitloopdiensten: 0 })).toBeCloseTo(3);
    expect(beginstandPunten({ nachten: 0, avonden: 0, avonden_weekend: 2, dagdiensten: 3, uitloopdiensten: 5 })).toBeCloseTo(6);
  });
});

describe('against the average per fte x maanden', () => {
  it('the same as everyone: nothing; more: fewer now; less: more now', () => {
    const s = beginstandSaldi([rij('a'), rij('b'), rij('c', { nachten: 25, feestdagdiensten: 5 }), rij('d', { nachten: 0, feestdagdiensten: 0 })]);
    // 28 points each, but c 15 more and d 10 fewer: the average is 29,25.
    expect(s.get('a')!.saldo_punten).toBe(1.3);
    expect(s.get('c')!.saldo_punten).toBe(-13.7);
    expect(s.get('c')!.saldo_punten).toBeLessThan(0);
    expect(s.get('d')!.saldo_punten).toBeGreaterThan(0);
    expect(s.get('c')!.feestdag_achterstand).toBeCloseTo(2.25 - 5);
    expect(s.get('d')!.feestdag_achterstand).toBeCloseTo(2.25);
  });

  it('half the fte, or half the months, half the share', () => {
    const s = beginstandSaldi([rij('a', { fte: 1, nachten: 20 }), rij('b', { fte: 0.5, nachten: 0 }), rij('c', { maanden: 6, nachten: 0 })]);
    // b and c each count for half of a.
    expect(s.get('b')!.saldo_punten).toBeCloseTo(s.get('c')!.saldo_punten, 1);
  });

  it('the saldi add up to nothing, whatever was read in', () => {
    const aantal = fc.integer({ min: 0, max: 200 });
    const persoon = fc.record({
      nachten: aantal,
      avonden: aantal,
      avonden_weekend: aantal,
      dagdiensten: aantal,
      uitloopdiensten: aantal,
      feestdagdiensten: fc.integer({ min: 0, max: 20 }),
      fte: fc.constantFrom(0.5, 0.6, 0.8, 0.9, 1),
      maanden: fc.integer({ min: 1, max: 48 }),
    });
    fc.assert(
      fc.property(fc.array(persoon, { minLength: 1, maxLength: 30 }), (mensen) => {
        const s = beginstandSaldi(mensen.map((m, i) => ({ person_id: `p${i}`, ...m })));
        const som = [...s.values()].reduce((t, x) => t + x.saldo_punten, 0);
        const somF = [...s.values()].reduce((t, x) => t + x.feestdag_achterstand, 0);
        // Rounded per person to a tenth (and a hundredth): at most that much off each.
        expect(Math.abs(som)).toBeLessThanOrEqual(0.05 * mensen.length + 1e-9);
        expect(Math.abs(somF)).toBeLessThanOrEqual(0.005 * mensen.length + 1e-9);
      })
    );
  });
});

describe('the nights have a saldo of their own', () => {
  it('against the average nights per fte x maanden: more nights, fewer now; fewer, more now', () => {
    const s = beginstandSaldi([rij('a'), rij('b'), rij('c', { nachten: 25 }), rij('d', { nachten: 0 })]);
    // 45 nights over four with the same fte and months: 11,25 each.
    expect(s.get('a')!.saldo_nachten).toBeCloseTo(1.3, 1);
    expect(s.get('c')!.saldo_nachten).toBeLessThan(-13);
    expect(s.get('d')!.saldo_nachten).toBeCloseTo(11.3, 1);
  });

  it('half the fte, half the share of the nights', () => {
    const s = beginstandSaldi([rij('a', { fte: 1, nachten: 20 }), rij('b', { fte: 0.5, nachten: 0 }), rij('c', { fte: 0.5, nachten: 0 })]);
    expect(s.get('b')!.saldo_nachten).toBeCloseTo(s.get('c')!.saldo_nachten, 1);
    expect(s.get('b')!.saldo_nachten).toBeGreaterThan(0);
  });

  it('the night saldi add up to nothing, whatever was read in', () => {
    const aantal = fc.integer({ min: 0, max: 200 });
    const persoon = fc.record({
      nachten: aantal,
      avonden: aantal,
      avonden_weekend: aantal,
      dagdiensten: aantal,
      uitloopdiensten: aantal,
      feestdagdiensten: fc.integer({ min: 0, max: 20 }),
      fte: fc.constantFrom(0.5, 0.6, 0.8, 0.9, 1),
      maanden: fc.integer({ min: 1, max: 48 }),
    });
    fc.assert(
      fc.property(fc.array(persoon, { minLength: 1, maxLength: 30 }), (mensen) => {
        const s = beginstandSaldi(mensen.map((m, i) => ({ person_id: `p${i}`, ...m })));
        const som = [...s.values()].reduce((t, x) => t + x.saldo_nachten, 0);
        expect(Math.abs(som)).toBeLessThanOrEqual(0.05 * mensen.length + 1e-9);
      })
    );
  });
});

describe('in words', () => {
  it('extra or minder, never a sign, a comma for the decimals', () => {
    expect(aiosSaldoWoorden({ saldo_punten: 2.4, saldo_nachten: 0, feestdag_achterstand: 0 })).toBe('2,4 punten extra');
    expect(aiosSaldoWoorden({ saldo_punten: -1, saldo_nachten: 0, feestdag_achterstand: 0 })).toBe('1 punt minder');
    expect(aiosSaldoWoorden({ saldo_punten: 0, saldo_nachten: 0, feestdag_achterstand: 1 })).toBe('1 feestdagdienst extra');
    expect(aiosSaldoWoorden({ saldo_punten: -0.6, saldo_nachten: 0, feestdag_achterstand: -1.5 })).toBe('0,6 punten minder en 1,5 feestdagdiensten minder');
    expect(aiosSaldoWoorden({ saldo_punten: 0.02, saldo_nachten: 0, feestdag_achterstand: 0.01 })).toBe('niets in te halen');
    fc.assert(
      fc.property(fc.double({ min: -50, max: 50, noNaN: true }), fc.double({ min: -5, max: 5, noNaN: true }), (p, f) => {
        expect(aiosSaldoWoorden({ saldo_punten: p, saldo_nachten: 0, feestdag_achterstand: f })).not.toMatch(/[-+]\d/);
      })
    );
  });
});

describe('the nights saldo in words', () => {
  it('a nachtdienst or nachtdiensten, extra or minder, with the points', () => {
    expect(aiosSaldoWoorden({ saldo_punten: 0, saldo_nachten: 1, feestdag_achterstand: 0 })).toBe('1 nachtdienst extra');
    expect(aiosSaldoWoorden({ saldo_punten: 0, saldo_nachten: -2, feestdag_achterstand: 0 })).toBe('2 nachtdiensten minder');
    expect(aiosSaldoWoorden({ saldo_punten: 1.2, saldo_nachten: 1.5, feestdag_achterstand: 0 })).toBe('1,2 punten extra en 1,5 nachtdiensten extra');
    expect(aiosSaldoWoorden({ saldo_punten: 0, saldo_nachten: 0.02, feestdag_achterstand: 0 })).toBe('niets in te halen');
    // Three: a comma, then "en" before the last, as the Dutch style wants.
    expect(aiosSaldoWoorden({ saldo_punten: 2, saldo_nachten: -1, feestdag_achterstand: 1 })).toBe('2 punten extra, 1 nachtdienst minder en 1 feestdagdienst extra');
  });
});
