import { describe, it, expect } from 'vitest';
import { computeCoverageFactor } from '@/lib/coverageFactor';

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
