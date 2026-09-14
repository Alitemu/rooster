import { describe, it, expect } from 'vitest';
import { resolveBands, countNominalAvondWeekendDays, type Teller } from './rosterBands';

/**
 * Band rounding - the [min, max] a planner sees as "streefaantal" when no
 * explicit band is configured yet (the SetupWizard's live suggestion).
 *
 * The rule isn't a plain [floor, ceil] of the average: a fractional average
 * of x,5 or higher means most people are going to need the higher count
 * anyway, so the band steps a further whole number up ([floor+2, floor+3])
 * instead of just to [floor+1, floor+2] - and an exact whole-number average
 * still gets a real two-value band ([n, n+1]) rather than collapsing to a
 * single value.
 */
describe('resolveBands - default rounding', () => {
  const counts = (avond: number): Record<Teller, number> => ({
    AVOND: avond,
    WEEKEND: 0,
    FEESTDAG: 0,
  });

  it('rounds an exact whole-number average up to [n, n+1], not [n, n]', () => {
    // 180 slots / 12 people = 15 exactly.
    expect(resolveBands({}, counts(180), 12).AVOND).toEqual([15, 16]);
    // 72 slots / 12 people = 6 exactly.
    expect(resolveBands({}, counts(72), 12).AVOND).toEqual([6, 7]);
  });

  it('leaves a below-.5 fraction as the ordinary [floor, ceil]', () => {
    // 63 / 10 = 6.3
    expect(resolveBands({}, counts(63), 10).AVOND).toEqual([6, 7]);
  });

  it('bumps a .5-or-higher fraction a further step up to [floor+2, floor+3]', () => {
    // 65 / 10 = 6.5
    expect(resolveBands({}, counts(65), 10).AVOND).toEqual([8, 9]);
    // 68 / 10 = 6.8
    expect(resolveBands({}, counts(68), 10).AVOND).toEqual([8, 9]);
  });

  it('stays at the ordinary band just below the .5 boundary', () => {
    // 649 / 100 = 6.49
    expect(resolveBands({}, counts(649), 100).AVOND).toEqual([6, 7]);
  });

  it('never suggests a nonzero band for a counter with zero slots', () => {
    expect(resolveBands({}, counts(0), 12).AVOND).toEqual([0, 0]);
  });

  it('an explicit band in the ruleset always wins over the default rounding', () => {
    expect(resolveBands({ bandAvond: [3, 3] }, counts(180), 12).AVOND).toEqual([3, 3]);
  });
});

/**
 * countNominalAvondWeekendDays - the AVOND/WEEKEND band suggestion is
 * meant to reflect a period's plain weekly structure (5 weekdays + 2
 * weekend days), not this particular period's sprinkling of feestdagen.
 * Feestdagen are counted by their ordinary weekday here on purpose - a
 * holiday on a Tuesday is still a Tuesday for this count.
 */
describe('countNominalAvondWeekendDays', () => {
  it('splits a whole number of weeks into 5 weekdays + 2 weekend days each, regardless of any holiday in range', () => {
    // 2026-12-28 (Monday) through 2027-09-05 (Sunday) = exactly 36 weeks,
    // and contains real feestdagen (Nieuwjaar, Pasen, Koningsdag, ...).
    const result = countNominalAvondWeekendDays('2026-12-28', '2027-09-05');
    expect(result).toEqual({ AVOND: 180, WEEKEND: 72 });
  });

  it('counts a single Monday-to-Sunday week as 5 and 2', () => {
    expect(countNominalAvondWeekendDays('2027-01-04', '2027-01-10')).toEqual({ AVOND: 5, WEEKEND: 2 });
  });
});
