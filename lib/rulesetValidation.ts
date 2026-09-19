/**
 * One validation for the ruleset, whichever route writes it.
 *
 * A period's ruleset is written in two places: POST /api/periods/[id]/open
 * freezes it onto the period, and PATCH /api/periods/[id]/ruleset edits it
 * afterwards. Only the second one checked its values, so the same setting
 * was accepted or refused depending on which screen a planner happened to
 * use - and the freeze route is the one that decides what the very first
 * generate runs against.
 *
 * What got through that way was not cosmetic. solver/main.py declares the
 * bands as `tuple[int, int]` and the windows as ints, so a fractional value
 * was only rejected three layers down as a raw 422 that names no setting; a
 * window of 1000 makes floor(weeks / windowWeeks) zero, i.e. a period with
 * no capacity at all and no visible reason why; and an unknown objectiveMode
 * simply never matched a branch.
 *
 * Every field is optional here - both callers fill in defaults for what a
 * planner did not set - except the three bands when `requireBands` is on,
 * which is what the freeze route has always demanded.
 */

export interface RulesetValidationError {
  code: string;
  message: string;
}

/**
 * Upper bound for a window, in weeks.
 *
 * Generous rather than tight: the setup form offers 0-8, and a window
 * longer than the period itself already reduces capacity to zero, so
 * anything near this is meaningless in practice. It is here to keep the
 * value in a range the rest of the stack can reason about, not to second-
 * guess a planner.
 */
export const MAX_WINDOW_WEEKS = 52;

const OBJECTIVE_MODES = ['weighted', 'lexicographic', 'multi_start', 'randomized'] as const;
const RANDOMIZED_VARIANTS = ['medewerker', 'dagen'] as const;
const TELLERS = ['AVOND', 'WEEKEND', 'FEESTDAG'] as const;

/**
 * A band is a count of shifts, so both ends are whole numbers.
 */
function isValidBand(band: unknown): boolean {
  return (
    Array.isArray(band) &&
    band.length === 2 &&
    band.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0) &&
    band[0] <= band[1]
  );
}

function isValidBudget(budget: unknown): boolean {
  if (!budget || typeof budget !== 'object') return false;
  const b = budget as Record<string, unknown>;
  for (const teller of TELLERS) {
    const entry = b[teller] as { maxFraction?: unknown } | undefined;
    if (
      !entry ||
      typeof entry.maxFraction !== 'number' ||
      !Number.isFinite(entry.maxFraction) ||
      entry.maxFraction < 0 ||
      entry.maxFraction > 1
    ) {
      return false;
    }
  }
  return typeof b.parttimeExempt === 'boolean';
}

function isNumberAtLeast(value: unknown, min: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

function isNumberAbove(value: unknown, min: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > min;
}

/**
 * Returns the first problem found, or null when everything present is
 * acceptable. Messages are user-facing Dutch and name the setting as the
 * screen labels it.
 */
export function validateRulesetFields(
  input: Record<string, unknown>,
  options: { requireBands?: boolean } = {}
): RulesetValidationError | null {
  for (const [label, key] of [
    ['Venster', 'windowWeeks'],
    ['Venster (avond)', 'windowWeeksAvond'],
    ['Venster (weekend/feestdag)', 'windowWeeksWeekendFeestdag'],
  ] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_WINDOW_WEEKS) {
      return {
        code: 'INVALID_WINDOW',
        message: `"${label}" moet een heel getal tussen 0 en ${MAX_WINDOW_WEEKS} zijn`,
      };
    }
  }

  for (const key of ['bandAvond', 'bandWeekend', 'bandFeestdag'] as const) {
    const band = input[key];
    if (band === undefined) {
      if (options.requireBands) {
        return {
          code: 'INVALID_BAND',
          message: `${key}: min en max moeten hele getallen zijn (min <= max, min >= 0)`,
        };
      }
      continue;
    }
    if (!isValidBand(band)) {
      return {
        code: 'INVALID_BAND',
        message: `${key}: min en max moeten hele getallen zijn (min <= max, min >= 0)`,
      };
    }
  }

  for (const key of ['blockBudget', 'softBlockBudget'] as const) {
    const budget = input[key];
    if (budget !== undefined && !isValidBudget(budget)) {
      return {
        code: 'INVALID_BUDGET',
        message: `${key}: percentage per teller moet tussen 0 en 100 liggen`,
      };
    }
  }

  // Solver objective weights ("Geavanceerde instellingen" in
  // RosterGenerationDialog) - mirrors the validation solver/main.py's
  // RuleSet itself enforces, so a bad value is caught with a Dutch message
  // rather than surfacing as a raw 422 from the solver later.
  if (input.softBlockPenalty !== undefined && !isNumberAtLeast(input.softBlockPenalty, 0)) {
    return { code: 'INVALID_WEIGHT', message: '"Liever niet genegeerd" moet 0 of hoger zijn' };
  }

  if (input.bandDeviationPenalty !== undefined) {
    const tiers = input.bandDeviationPenalty;
    const valid =
      Array.isArray(tiers) && tiers.length > 0 && tiers.every((t) => isNumberAbove(t, 0));
    if (!valid) {
      return {
        code: 'INVALID_WEIGHT',
        message: '"Buiten streefbereik (trappen)" moet minstens één getal groter dan 0 bevatten',
      };
    }
  }

  if (input.bandDeviationMultiplier !== undefined && !isNumberAtLeast(input.bandDeviationMultiplier, 1)) {
    return { code: 'INVALID_WEIGHT', message: '"Vermenigvuldigingsfactor" moet 1 of hoger zijn' };
  }

  if (input.shortfallWeight !== undefined && !isNumberAbove(input.shortfallWeight, 0)) {
    return { code: 'INVALID_WEIGHT', message: '"Lege dienst" moet groter dan 0 zijn' };
  }

  if (input.bandImbalanceWeight !== undefined && !isNumberAtLeast(input.bandImbalanceWeight, 0)) {
    return { code: 'INVALID_WEIGHT', message: '"Ongelijke verdeling" moet 0 of hoger zijn' };
  }

  if (input.preferenceRewardWeight !== undefined && !isNumberAtLeast(input.preferenceRewardWeight, 0)) {
    return { code: 'INVALID_WEIGHT', message: '"Voorkeur gehonoreerd" moet 0 of hoger zijn' };
  }

  if (
    input.objectiveMode !== undefined &&
    !OBJECTIVE_MODES.includes(input.objectiveMode as (typeof OBJECTIVE_MODES)[number])
  ) {
    return {
      code: 'INVALID_OBJECTIVE_MODE',
      message: '"Optimalisatiemethode" moet "weighted", "lexicographic", "multi_start" of "randomized" zijn',
    };
  }

  if (
    input.maxAttempts !== undefined &&
    (typeof input.maxAttempts !== 'number' || !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)
  ) {
    return { code: 'INVALID_WEIGHT', message: '"Aantal pogingen" moet een geheel getal van 1 of hoger zijn' };
  }

  if (
    input.randomizedVariant !== undefined &&
    !RANDOMIZED_VARIANTS.includes(input.randomizedVariant as (typeof RANDOMIZED_VARIANTS)[number])
  ) {
    return { code: 'INVALID_OBJECTIVE_MODE', message: '"Volgorde" moet "medewerker" of "dagen" zijn' };
  }

  return null;
}
