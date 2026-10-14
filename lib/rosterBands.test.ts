import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveBands, resolvePeriodBands, scaledBandForMember, countNominalAvondWeekendDays, type Teller } from './rosterBands';

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

  it('keeps a .5-or-higher fraction at [floor, ceil] too', () => {
    // 65 / 10 = 6.5
    expect(resolveBands({}, counts(65), 10).AVOND).toEqual([6, 7]);
    // 68 / 10 = 6.8
    expect(resolveBands({}, counts(68), 10).AVOND).toEqual([6, 7]);
  });

  it('always leaves room for everyone: the band holds the average', () => {
    // The period's slots divided evenly must fit inside every default band,
    // or nobody can end up inside it (40 avonddiensten / 16 = 2.5).
    for (const [slots, people] of [[40, 16], [65, 10], [68, 10], [180, 12], [7, 31]]) {
      const [min, max] = resolveBands({}, counts(slots), people).AVOND;
      expect(min * people).toBeLessThanOrEqual(slots);
      expect(max * people).toBeGreaterThanOrEqual(slots);
    }
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

/**
 * The default streefbereik, over any members (audit 15): whoever joins
 * or leaves halfway, at whatever deelnamefactor under NAAR_RATO, with or
 * without fellows, the members' maximums together hold every shift and
 * their minimums together never ask for more shifts than there are. A
 * band whose maximums fall short leaves shifts empty however long the
 * solver runs, which is what counting heads instead of coverage did.
 */
describe('the default bands over random members', () => {
  const member = fc.record({
    dekking: fc.double({ min: 0.01, max: 1, noNaN: true }),
    deelnamefactor: fc.double({ min: 0.05, max: 1, noNaN: true }),
    fellow: fc.boolean(),
  });

  it('hold every shift and ask for no more than there are', () => {
    fc.assert(
      fc.property(
        fc.array(member, { minLength: 1, maxLength: 40 }),
        fc.record({ AVOND: fc.nat(400), WEEKEND: fc.nat(200), FEESTDAG: fc.nat(20) }),
        fc.constantFrom('GELIJK', 'NAAR_RATO'),
        (raw, slots, mode) => {
          const members = raw.map((m, i) => ({ id: `p${i}`, dekking: m.dekking, deelnamefactor: m.deelnamefactor }));
          const fellows = new Set(raw.flatMap((m, i) => (m.fellow ? [`p${i}`] : [])));
          const bands = resolvePeriodBands({}, slots, members, fellows, mode);
          for (const teller of ['AVOND', 'WEEKEND', 'FEESTDAG'] as const) {
            // Fellows do no weekends when someone else can (resolvePeriodBands).
            const counted =
              teller === 'WEEKEND' && fellows.size > 0 && fellows.size < members.length
                ? members.filter((m) => !fellows.has(m.id))
                : members;
            const own = counted.map((m) => scaledBandForMember(bands, teller, m, mode));
            for (const [min, max] of own) {
              expect(min).toBeGreaterThanOrEqual(0);
              expect(max).toBeGreaterThanOrEqual(min);
            }
            const weight = counted.reduce((s, m) => s + m.dekking * (mode === 'NAAR_RATO' ? m.deelnamefactor : 1), 0);
            if (weight > 0) {
              expect(own.reduce((s, [, max]) => s + max, 0), `${teller} maxima`).toBeGreaterThanOrEqual(slots[teller]);
            }
            expect(own.reduce((s, [min]) => s + min, 0), `${teller} minima`).toBeLessThanOrEqual(slots[teller]);
          }
        }
      ),
      { numRuns: 2000 }
    );
  });
});
