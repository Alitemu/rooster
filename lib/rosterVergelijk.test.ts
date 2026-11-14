import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isBetterRoster, isPerfectRoster } from './rosterVergelijk';

/**
 * The planner that repeats keeps the best of its attempts. "Better" is the
 * order the solver itself optimises in: first fewer empty diensten, then a
 * smaller largest deviation from the streefbereik, then a smaller total
 * deviation, then fewer liever-niet violations, then more voorkeuren.
 */

const d = (o: Partial<{ leeg: number; max: number; totaal: number; soft: number; voorkeur: number }> = {}) => ({
  unfilled_slots: Array.from({ length: o.leeg ?? 0 }, (_, i) => ({ slot_id: `s${i}`, shortfall: 1 })),
  max_band_deviation: o.max ?? 0,
  total_band_deviation: o.totaal ?? 0,
  soft_block_violations: o.soft ?? 0,
  preference_matches: o.voorkeur ?? 0,
});

describe('isBetterRoster', () => {
  it('ranks by empty diensten first, whatever the rest says', () => {
    expect(isBetterRoster(d({ leeg: 0, max: 9, totaal: 99, soft: 9, voorkeur: 0 }), d({ leeg: 1, max: 0 }))).toBe(true);
    expect(isBetterRoster(d({ leeg: 1 }), d({ leeg: 0, max: 9 }))).toBe(false);
  });

  it.each([
    ['the largest deviation', { max: 1 }, { max: 2 }],
    ['the total deviation', { totaal: 3 }, { totaal: 4 }],
    ['the liever-niet violations', { soft: 0 }, { soft: 1 }],
    ['the voorkeuren matched (more is better)', { voorkeur: 5 }, { voorkeur: 4 }],
  ])('then by %s', (_naam, beter, slechter) => {
    expect(isBetterRoster(d(beter), d(slechter))).toBe(true);
    expect(isBetterRoster(d(slechter), d(beter))).toBe(false);
  });

  it('puts an earlier criterion before a later one', () => {
    expect(isBetterRoster(d({ max: 1, totaal: 50 }), d({ max: 2, totaal: 0 }))).toBe(true);
    expect(isBetterRoster(d({ totaal: 1, soft: 9 }), d({ totaal: 2, soft: 0 }))).toBe(true);
    expect(isBetterRoster(d({ soft: 1, voorkeur: 0 }), d({ soft: 2, voorkeur: 99 }))).toBe(true);
  });

  it('a full tie is not better, so the first found stays', () => {
    expect(isBetterRoster(d({ max: 1, totaal: 2, soft: 3, voorkeur: 4 }), d({ max: 1, totaal: 2, soft: 3, voorkeur: 4 }))).toBe(false);
  });

  it('reads missing fields as zero, never as a reason to win or lose', () => {
    expect(isBetterRoster({}, {})).toBe(false);
    expect(isBetterRoster(undefined, undefined)).toBe(false);
    expect(isBetterRoster({ unfilled_slots: [] }, d({ max: 1 }))).toBe(true);
  });

  it('is a strict order: never both ways better, and a better one beats every worse one (property)', () => {
    const uitkomst = fc.record({
      leeg: fc.nat(3),
      max: fc.nat(3),
      totaal: fc.nat(3),
      soft: fc.nat(3),
      voorkeur: fc.nat(3),
    });
    fc.assert(
      fc.property(uitkomst, uitkomst, (a, b) => {
        const ab = isBetterRoster(d(a), d(b));
        const ba = isBetterRoster(d(b), d(a));
        expect(ab && ba).toBe(false);
        const gelijk = JSON.stringify(a) === JSON.stringify(b);
        if (!gelijk) expect(ab || ba).toBe(true);
      })
    );
  });
});

describe('isPerfectRoster', () => {
  it('is every dienst filled and everyone exactly within the streefbereik', () => {
    expect(isPerfectRoster(d())).toBe(true);
    expect(isPerfectRoster(d({ totaal: 0, soft: 4, voorkeur: 1 }))).toBe(true);
  });

  it('is not perfect with an empty dienst or any deviation', () => {
    expect(isPerfectRoster(d({ leeg: 1 }))).toBe(false);
    expect(isPerfectRoster(d({ max: 1 }))).toBe(false);
  });

  it('does not take a result that says nothing about empty diensten for a perfect one', () => {
    expect(isPerfectRoster({ unfilled_slots: [] })).toBe(true);
    expect(isPerfectRoster(undefined)).toBe(false);
    expect(isPerfectRoster({})).toBe(false);
    expect(isPerfectRoster({ max_band_deviation: 0 })).toBe(false);
  });
});
