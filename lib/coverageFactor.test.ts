import { describe, it, expect } from 'vitest';
import { combinedMembership, computeCoverageFactor } from '@/lib/coverageFactor';

describe('computeCoverageFactor', () => {
  it('returns 1.0 when membership spans the whole period exactly', () => {
    const factor = computeCoverageFactor('2027-01-04', '2027-06-06', '2027-01-04', '2027-06-06');
    expect(factor).toBe(1);
  });

  it('returns 1.0 (clamped) when membership fully spans and extends beyond the period', () => {
    const factor = computeCoverageFactor('2026-01-01', '2028-01-01', '2027-01-04', '2027-06-06');
    expect(factor).toBe(1);
  });

  it('returns ~0.25 for a membership covering exactly the first quarter of an 8-week period', () => {
    // 8 weeks = 56 days, 2027-01-04 (Mon) .. 2027-02-28 (Sun)
    const periodStart = '2027-01-04';
    const periodEnd = '2027-02-28';
    // First 2 weeks = 14 days = first quarter of 56
    const factor = computeCoverageFactor(periodStart, '2027-01-17', periodStart, periodEnd);
    expect(factor).toBeCloseTo(0.25, 5);
  });

  it('returns ~0.5 for a membership covering exactly the first half of an 8-week period', () => {
    const periodStart = '2027-01-04';
    const periodEnd = '2027-02-28';
    const factor = computeCoverageFactor(periodStart, '2027-01-31', periodStart, periodEnd);
    expect(factor).toBeCloseTo(0.5, 5);
  });

  it('returns ~0.75 for a membership covering the last three-quarters of an 8-week period', () => {
    const periodStart = '2027-01-04';
    const periodEnd = '2027-02-28';
    const factor = computeCoverageFactor('2027-01-18', periodEnd, periodStart, periodEnd);
    expect(factor).toBeCloseTo(0.75, 5);
  });

  it('returns 0 when the membership does not overlap the period at all', () => {
    const factor = computeCoverageFactor('2026-01-01', '2026-06-01', '2027-01-04', '2027-06-06');
    expect(factor).toBe(0);
  });

  it('clamps a membership that starts before and ends before the period midpoint', () => {
    const factor = computeCoverageFactor('2026-12-01', '2027-01-17', '2027-01-04', '2027-02-28');
    // Overlap is 2027-01-04 .. 2027-01-17 = same 14/56 = 0.25 as the quarter case
    expect(factor).toBeCloseTo(0.25, 5);
  });
});

describe('combinedMembership: all of a person\'s memberships in one period', () => {
  const P = ['2027-01-04', '2027-02-28'] as const; // 8 weeks, 56 days
  const m = (geldig_vanaf: string, geldig_tot: string, deelnamefactor = 1) => ({ geldig_vanaf, geldig_tot, deelnamefactor });

  it('one membership comes out exactly as computeCoverageFactor', () => {
    for (const [v, t] of [['2020-01-01', '2099-12-31'], ['2027-02-01', '2099-12-31'], ['2027-01-10', '2027-01-20']] as const) {
      expect(combinedMembership([m(v, t, 0.8)], ...P)).toEqual({ dekking: computeCoverageFactor(v, t, ...P), deelnamefactor: 0.8 });
    }
  });

  it('two halves with nothing between them make the whole period', () => {
    expect(combinedMembership([m('2020-01-01', '2027-01-17'), m('2027-01-18', '2099-12-31')], ...P)).toEqual({ dekking: 1, deelnamefactor: 1 });
  });

  it('a gap between them is left out', () => {
    // 14 + 28 of 56 days: two weeks away in between.
    expect(combinedMembership([m('2020-01-01', '2027-01-17'), m('2027-02-01', '2099-12-31')], ...P).dekking).toBe(42 / 56);
  });

  it('weighs the deelnamefactor by the days of each', () => {
    // 14 days at 1.0 and 42 at 0.8: (14 + 33.6) / 56 = 0.85.
    expect(combinedMembership([m('2020-01-01', '2027-01-17', 1), m('2027-01-18', '2099-12-31', 0.8)], ...P).deelnamefactor).toBeCloseTo(0.85, 12);
  });

  it('keeps a factor every membership shares as it is', () => {
    expect(combinedMembership([m('2020-01-01', '2027-01-17', 0.8), m('2027-01-25', '2099-12-31', 0.8)], ...P).deelnamefactor).toBe(0.8);
  });
});
