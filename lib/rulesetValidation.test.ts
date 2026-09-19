import { describe, it, expect } from 'vitest';
import { validateRulesetFields, MAX_WINDOW_WEEKS } from './rulesetValidation';

/**
 * The hard rule: a ruleset value is judged the same way no matter which
 * route writes it.
 *
 * POST .../open freezes the ruleset onto the period and PATCH .../ruleset
 * edits it afterwards. They used to carry separate copies of this check,
 * and the freeze route's copy was the weaker one - it looked at the bands
 * only, and accepted fractional ones at that. Both now call this, so the
 * table below is the single place that decides.
 */

/** A ruleset with every field set to something acceptable. */
const VALID = {
  windowWeeks: 2,
  windowWeeksAvond: 2,
  windowWeeksWeekendFeestdag: 3,
  bandAvond: [7, 8],
  bandWeekend: [1, 2],
  bandFeestdag: [0, 1],
  blockBudget: {
    AVOND: { maxFraction: 0.5 },
    WEEKEND: { maxFraction: 0.5 },
    FEESTDAG: { maxFraction: 0.5 },
    parttimeExempt: true,
  },
  softBlockBudget: {
    AVOND: { maxFraction: 0.3 },
    WEEKEND: { maxFraction: 0.3 },
    FEESTDAG: { maxFraction: 0.3 },
    parttimeExempt: false,
  },
  softBlockPenalty: 10,
  bandDeviationPenalty: [1, 4, 9],
  bandDeviationMultiplier: 2,
  shortfallWeight: 1000,
  bandImbalanceWeight: 0,
  preferenceRewardWeight: 5,
  objectiveMode: 'lexicographic',
  maxAttempts: 3,
  randomizedVariant: 'medewerker',
};

/** Every value that must be refused, and the code it must be refused with. */
const REJECTED: Array<[string, Record<string, unknown>, string]> = [
  ['fractional windowWeeks', { windowWeeks: 2.5 }, 'INVALID_WINDOW'],
  ['negative windowWeeks', { windowWeeks: -1 }, 'INVALID_WINDOW'],
  ['windowWeeks past the cap', { windowWeeks: MAX_WINDOW_WEEKS + 1 }, 'INVALID_WINDOW'],
  ['windowWeeks as a string', { windowWeeks: '2' }, 'INVALID_WINDOW'],
  ['fractional windowWeeksAvond', { windowWeeksAvond: 1.5 }, 'INVALID_WINDOW'],
  ['fractional windowWeeksWeekendFeestdag', { windowWeeksWeekendFeestdag: 1.5 }, 'INVALID_WINDOW'],
  ['fractional band', { bandAvond: [7.5, 8.5] }, 'INVALID_BAND'],
  ['inverted band', { bandAvond: [9, 3] }, 'INVALID_BAND'],
  ['negative band', { bandAvond: [-2, 3] }, 'INVALID_BAND'],
  ['band of one element', { bandAvond: [3] }, 'INVALID_BAND'],
  ['band that is not an array', { bandWeekend: 5 }, 'INVALID_BAND'],
  ['band of strings', { bandFeestdag: ['1', '2'] }, 'INVALID_BAND'],
  [
    'budget fraction above 1',
    { blockBudget: { ...VALID.blockBudget, AVOND: { maxFraction: 2 } } },
    'INVALID_BUDGET',
  ],
  [
    'negative budget fraction',
    { blockBudget: { ...VALID.blockBudget, AVOND: { maxFraction: -0.1 } } },
    'INVALID_BUDGET',
  ],
  ['budget missing a teller', { blockBudget: { AVOND: { maxFraction: 0.5 }, parttimeExempt: true } }, 'INVALID_BUDGET'],
  [
    'budget without parttimeExempt',
    {
      blockBudget: {
        AVOND: { maxFraction: 0.5 },
        WEEKEND: { maxFraction: 0.5 },
        FEESTDAG: { maxFraction: 0.5 },
      },
    },
    'INVALID_BUDGET',
  ],
  ['soft budget out of range', { softBlockBudget: { ...VALID.softBlockBudget, WEEKEND: { maxFraction: 5 } } }, 'INVALID_BUDGET'],
  ['negative softBlockPenalty', { softBlockPenalty: -5 }, 'INVALID_WEIGHT'],
  ['empty bandDeviationPenalty', { bandDeviationPenalty: [] }, 'INVALID_WEIGHT'],
  ['bandDeviationPenalty with a zero tier', { bandDeviationPenalty: [1, 0] }, 'INVALID_WEIGHT'],
  ['bandDeviationMultiplier below 1', { bandDeviationMultiplier: 0.5 }, 'INVALID_WEIGHT'],
  ['shortfallWeight of 0', { shortfallWeight: 0 }, 'INVALID_WEIGHT'],
  ['negative bandImbalanceWeight', { bandImbalanceWeight: -1 }, 'INVALID_WEIGHT'],
  ['negative preferenceRewardWeight', { preferenceRewardWeight: -1 }, 'INVALID_WEIGHT'],
  ['maxAttempts of 0', { maxAttempts: 0 }, 'INVALID_WEIGHT'],
  ['fractional maxAttempts', { maxAttempts: 2.5 }, 'INVALID_WEIGHT'],
  ['unknown objectiveMode', { objectiveMode: 'magie' }, 'INVALID_OBJECTIVE_MODE'],
  ['unknown randomizedVariant', { randomizedVariant: 'willekeurig' }, 'INVALID_OBJECTIVE_MODE'],
  ['infinite weight', { softBlockPenalty: Infinity }, 'INVALID_WEIGHT'],
  ['NaN weight', { shortfallWeight: NaN }, 'INVALID_WEIGHT'],
];

describe('validateRulesetFields', () => {
  it('accepts a ruleset with every field set to a sane value', () => {
    expect(validateRulesetFields(VALID)).toBeNull();
  });

  it('accepts a ruleset that sets nothing at all', () => {
    expect(validateRulesetFields({})).toBeNull();
  });

  it.each(REJECTED)('rejects %s', (_label, override, expectedCode) => {
    const result = validateRulesetFields({ ...VALID, ...override });
    expect(result).not.toBeNull();
    expect(result!.code).toBe(expectedCode);
    // The message is what a planner reads, so it must not be empty.
    expect(result!.message.length).toBeGreaterThan(0);
  });

  it('accepts a window of exactly 0 and exactly the cap', () => {
    expect(validateRulesetFields({ windowWeeks: 0 })).toBeNull();
    expect(validateRulesetFields({ windowWeeks: MAX_WINDOW_WEEKS })).toBeNull();
  });

  it('accepts a band whose ends are equal', () => {
    expect(validateRulesetFields({ bandAvond: [8, 8] })).toBeNull();
  });

  it('accepts a budget at exactly 0 and exactly 1', () => {
    const budget = (f: number) => ({
      AVOND: { maxFraction: f },
      WEEKEND: { maxFraction: f },
      FEESTDAG: { maxFraction: f },
      parttimeExempt: false,
    });
    expect(validateRulesetFields({ blockBudget: budget(0) })).toBeNull();
    expect(validateRulesetFields({ blockBudget: budget(1) })).toBeNull();
  });

  describe('requireBands', () => {
    it('demands all three bands when the caller freezes a ruleset', () => {
      // POST .../open has always required these - a frozen ruleset with no
      // band leaves the solver nothing to aim at.
      expect(validateRulesetFields({ bandAvond: [7, 8] }, { requireBands: true })?.code).toBe('INVALID_BAND');
      expect(
        validateRulesetFields(
          { bandAvond: [7, 8], bandWeekend: [1, 2], bandFeestdag: [0, 1] },
          { requireBands: true }
        )
      ).toBeNull();
    });

    it('leaves a missing band alone when the caller is editing', () => {
      // PATCH .../ruleset is a partial update: not sending a band means
      // "leave it as it was", not "clear it".
      expect(validateRulesetFields({ windowWeeks: 2 })).toBeNull();
    });
  });
});
