import { describe, expect, it } from 'vitest';
import { bereikCel, bereikKort, buitenBereik } from './streefbereikPerPersoon';

const t = (min: number, max: number, extra: { saldo?: number; basis?: [number, number]; fellow?: boolean } = {}) => ({
  min,
  max,
  fellow: extra.fellow ?? false,
  basis: extra.basis,
  saldo: extra.saldo,
});

describe('the streefbereik per person (2.2.0)', () => {
  it('says the range in words, never "2-3"', () => {
    expect(bereikKort(2, 3)).toBe('2 of 3');
    expect(bereikKort(0, 1)).toBe('hoogstens 1');
    expect(bereikKort(0, 0)).toBe('geen');
    expect(bereikKort(2, 2)).toBe('2');
    expect(bereikKort(2, 5)).toBe('2 tot en met 5');
  });

  it('says where a saldo moved it, and nothing when none did', () => {
    expect(bereikCel(t(3, 4, { basis: [2, 3], saldo: 1 }))).toEqual({ tekst: '3 of 4', toelichting: 'basis 2 of 3, 1 dienst extra uit het saldo' });
    expect(bereikCel(t(0, 1, { basis: [2, 3], saldo: -2 }))).toEqual({ tekst: 'hoogstens 1', toelichting: 'basis 2 of 3, 2 diensten minder uit het saldo' });
    expect(bereikCel(t(2, 3, { basis: [2, 3], saldo: 0 })).toelichting).toBeNull();
  });

  it('marks fewer than the bottom and more than the top, but not a fellow with fewer weekends', () => {
    const doel = { AVOND: t(2, 3), WEEKEND: t(0, 1, { fellow: true }), FEESTDAG: t(0, 1) };
    expect(buitenBereik(doel, { AVOND: 1, WEEKEND: 0, FEESTDAG: 2 })).toEqual(['avond', 'feestdag']);
    expect(buitenBereik(doel, { AVOND: 4, WEEKEND: 0, FEESTDAG: 0 })).toEqual(['avond']);
    expect(buitenBereik(doel, { AVOND: 2, WEEKEND: 0, FEESTDAG: 1 })).toEqual([]);
  });
});
