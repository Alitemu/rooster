import { describe, expect, it } from 'vitest';
import { bereikCel, bereikKort, uitkomstPerSoort } from './streefbereikPerPersoon';
import { bereikVak } from './bereikVak';

const t = (min: number, max: number, extra: { saldo?: number; basis?: [number, number]; fellow?: boolean } = {}) => ({
  min,
  max,
  fellow: extra.fellow ?? false,
  basis: extra.basis,
  saldo: extra.saldo,
});

describe('the streefbereik per person (2.2.0)', () => {
  it('says the range in words and always in numbers, never "2-3" (2.3.0: "0 of 1", not "hoogstens 1")', () => {
    expect(bereikKort(2, 3)).toBe('2 of 3');
    expect(bereikKort(0, 1)).toBe('0 of 1');
    expect(bereikKort(0, 0)).toBe('0');
    expect(bereikKort(0, 3)).toBe('0 tot en met 3');
    expect(bereikKort(2, 2)).toBe('2');
    expect(bereikKort(2, 5)).toBe('2 tot en met 5');
  });

  it('says where a saldo moved it, and nothing when none did', () => {
    expect(bereikCel(t(3, 4, { basis: [2, 3], saldo: 1 }))).toEqual({ tekst: '3 of 4', toelichting: 'basis 2 of 3, 1 dienst extra uit het saldo' });
    expect(bereikCel(t(0, 1, { basis: [2, 3], saldo: -2 }))).toEqual({ tekst: '0 of 1', toelichting: 'basis 2 of 3, 2 diensten minder uit het saldo' });
    expect(bereikCel(t(2, 3, { basis: [2, 3], saldo: 0 })).toelichting).toBeNull();
  });

  it('says per kind whether the count fits, by how many it does not, and no shortfall for a fellow (2.3.0)', () => {
    const doel = { AVOND: t(2, 3), WEEKEND: t(0, 0, { fellow: true }), FEESTDAG: t(0, 1) };
    expect(uitkomstPerSoort(doel, { AVOND: 1, WEEKEND: 0, FEESTDAG: 2 })).toEqual({ AVOND: '1 tekort', WEEKEND: 'goed', FEESTDAG: '1 te veel' });
    expect(uitkomstPerSoort(doel, { AVOND: 5, WEEKEND: 1, FEESTDAG: 0 })).toEqual({ AVOND: '2 te veel', WEEKEND: '1 te veel', FEESTDAG: 'goed' });
    // Both edges of the range are inside it.
    expect(uitkomstPerSoort(doel, { AVOND: 2, WEEKEND: 0, FEESTDAG: 0 }).AVOND).toBe('goed');
    expect(uitkomstPerSoort(doel, { AVOND: 3, WEEKEND: 0, FEESTDAG: 1 })).toEqual({ AVOND: 'goed', WEEKEND: 'goed', FEESTDAG: 'goed' });
    expect(uitkomstPerSoort({ ...doel, AVOND: t(3, 4) }, { AVOND: 0, WEEKEND: 0, FEESTDAG: 0 }).AVOND).toBe('3 tekort');
    // A fellow's weekend with a range above 0 still has no shortfall.
    expect(uitkomstPerSoort({ ...doel, WEEKEND: t(1, 2, { fellow: true }) }, { AVOND: 2, WEEKEND: 0, FEESTDAG: 0 }).WEEKEND).toBe('goed');
  });

  it('puts the dashed box half a dienst past each edge of the range, never left of 0 (2.3.0)', () => {
    expect(bereikVak({ min: 2, max: 3 })).toEqual({ van: 1.5, tot: 3.5 });
    expect(bereikVak({ min: 3, max: 3 })).toEqual({ van: 2.5, tot: 3.5 });
    expect(bereikVak({ min: 0, max: 1 })).toEqual({ van: 0, tot: 1.5 });
    expect(bereikVak(null)).toBeNull();
    // A count on either edge ends inside the box, one more or one fewer outside it.
    for (const b of [{ min: 0, max: 1 }, { min: 2, max: 3 }, { min: 1, max: 4 }]) {
      const v = bereikVak(b)!;
      expect(v.van).toBeGreaterThanOrEqual(0);
      expect(b.min > v.van || b.min === 0).toBe(true);
      expect(b.max).toBeLessThan(v.tot);
      expect(b.max + 1).toBeGreaterThan(v.tot);
      if (b.min > 0) expect(b.min - 1).toBeLessThan(v.van);
    }
  });
});

describe('naar rato in the table (2.6.1, 2.6.2)', () => {
  const deel = (min: number, max: number, factor: number | undefined, saldo = 0, basis: [number, number] = [min, max]) => ({
    min,
    max,
    fellow: false,
    basis,
    saldo,
    factor,
  });

  it('says why someone there part of the period has a smaller range', () => {
    expect(bereikCel(deel(1, 2, 0.714)).toelichting).toBe('naar rato 71%');
    expect(bereikCel(deel(3, 4, 0.5, 2, [1, 2])).toelichting).toBe('basis 1 of 2, naar rato 50%, 2 diensten extra uit het saldo');
    // The table puts the explanation in brackets: no brackets of its own inside (2.6.2).
    for (const t of [deel(1, 2, 0.714), deel(3, 4, 0.5, 2, [1, 2]), deel(2, 3, undefined, -1, [3, 4])]) {
      expect(bereikCel(t).toelichting ?? '').not.toMatch(/[()]/);
    }
  });

  it('says nothing of it for someone there the whole period', () => {
    expect(bereikCel(deel(2, 3, undefined)).toelichting).toBeNull();
    expect(bereikCel(deel(3, 4, undefined, 1, [2, 3])).toelichting).toBe('basis 2 of 3, 1 dienst extra uit het saldo');
  });
});
