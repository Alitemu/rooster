/**
 * Band resolution for a period.
 *
 * A period's band per counter comes from its frozen ruleset. Both roster
 * generation and the pre-publication check need the exact same answer: if
 * they disagree, the solver produces a roster that the publication gate
 * then rejects (or waves through) for reasons the planner cannot see.
 *
 * Kept in one place for that reason - publication-check previously carried
 * its own hardcoded `[7, 8]`, which matched the real ruleset only by
 * coincidence.
 */

import { db } from '@/db/client';
import { parseISO } from '@/lib/holidays';

export type Teller = 'AVOND' | 'WEEKEND' | 'FEESTDAG';
export type Band = [number, number];
export type BandsByTeller = Record<Teller, Band>;

export const TELLERS: Teller[] = ['AVOND', 'WEEKEND', 'FEESTDAG'];

/**
 * Read a period's frozen ruleset, falling back to the pool's current one.
 *
 * Periods freeze their ruleset as JSON when opened, so later edits to the
 * pool's ruleset can't retroactively change an open period. The fallback
 * covers periods created before that freeze existed.
 */
export function resolveRulesetConfig(period: {
  bevroren_ruleset_json?: string | null;
  pool_id: string;
}): Record<string, unknown> {
  if (period.bevroren_ruleset_json) {
    try {
      return JSON.parse(period.bevroren_ruleset_json);
    } catch {
      // Corrupt frozen JSON shouldn't take down the whole request - fall
      // through to the pool's ruleset below.
    }
  }

  const pool = db
    .prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?')
    .get(period.pool_id) as { ruleset_id: string } | undefined;

  if (!pool) return {};

  const ruleset = db
    .prepare('SELECT config_json FROM dienstrooster_ruleset WHERE id = ?')
    .get(pool.ruleset_id) as { config_json: string } | undefined;

  if (!ruleset) return {};

  try {
    return JSON.parse(ruleset.config_json || '{}');
  } catch {
    return {};
  }
}

export interface WindowWeeksConfig {
  avond: number;
  weekendFeestdag: number;
}

/**
 * Resolve a period's window-rule settings, in the exact same shape
 * regardless of whether it was frozen before or after per-teller windows
 * existed - a period with only the old pooled `windowWeeks` gets that same
 * value for both groups (which, per requiredGapWeeks in lib/windowRule.ts,
 * reproduces the old pooled behaviour exactly: the cross-type floor and
 * each group's own cap both collapse to the same number).
 *
 * Shared by generate-roster/route.ts's solver request AND
 * lib/windowRule.ts's manual-assign/reassign conflict checks, so both
 * agree on what "the window" means for a given period - see
 * solver/constraints.py's add_window_constraints for the full
 * floor-plus-per-group reasoning this mirrors.
 */
export function resolveWindowWeeks(config: Record<string, unknown>): WindowWeeksConfig {
  const legacy = typeof config.windowWeeks === 'number' ? config.windowWeeks : 2;
  return {
    avond: typeof config.windowWeeksAvond === 'number' ? config.windowWeeksAvond : legacy,
    weekendFeestdag:
      typeof config.windowWeeksWeekendFeestdag === 'number' ? config.windowWeeksWeekendFeestdag : legacy,
  };
}

/**
 * Weekday (AVOND-eligible) and weekend-day counts for a date range,
 * counting every calendar day by its plain weekday - Saturday/Sunday are
 * WEEKEND, everything else is AVOND - regardless of whether that day is
 * also a feestdag.
 *
 * Exists because feestdagen are few but not zero: a handful of them
 * landing on what would otherwise be ordinary weekdays/weekend days in a
 * period is enough to knock an otherwise-exact average (e.g. 180 weekdays
 * / 12 people = 15) down to something like 14.9, which used to produce a
 * lower, "unrounder" band than the period's actual weekly structure
 * intends. The band is meant to reflect that structure, not this year's
 * particular sprinkling of holidays - see resolveBands' defaultBand below,
 * which consumes exactly this instead of a feestdag-adjusted slot count
 * for AVOND/WEEKEND.
 */
export function countNominalAvondWeekendDays(
  startDate: string,
  endDate: string
): { AVOND: number; WEEKEND: number } {
  const start = parseISO(startDate);
  const end = parseISO(endDate);
  let avond = 0;
  let weekend = 0;
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day === 0 || day === 6) weekend++;
    else avond++;
  }
  return { AVOND: avond, WEEKEND: weekend };
}

/**
 * Resolve the [min, max] band per counter for a period.
 *
 * A flat band for every counter is only feasible by coincidence - WEEKEND
 * and FEESTDAG have far fewer slots than AVOND - so when the ruleset
 * doesn't name a band explicitly we derive each counter's own band from
 * its actual average per person.
 *
 * The rounding is deliberately not a plain [floor, ceil]: a fractional
 * average of x,5 or higher means most people are going to end up needing
 * the higher count anyway, so the band is bumped a further step up
 * ([floor+2, floor+3]) rather than just to [floor+1, floor+2] - and an
 * exact whole-number average (fraction 0) still gets a real two-value
 * band, rounded up ([n, n+1]), instead of collapsing to a single value
 * [n, n]. Below x,5 the band is the ordinary [floor, ceil].
 */
export function resolveBands(
  config: Record<string, unknown>,
  slotCountByTeller: Record<Teller, number>,
  peopleCount: number
): BandsByTeller {
  const defaultBand = (teller: Teller): Band => {
    const total = slotCountByTeller[teller];
    if (total <= 0) return [0, 0];
    const avg = total / Math.max(peopleCount, 1);
    const n = Math.floor(avg);
    const frac = avg - n;
    return frac < 0.5 ? [n, n + 1] : [n + 2, n + 3];
  };

  const configured: Record<Teller, unknown> = {
    AVOND: config.bandAvond,
    WEEKEND: config.bandWeekend,
    FEESTDAG: config.bandFeestdag,
  };

  const bands = {} as BandsByTeller;
  for (const teller of TELLERS) {
    const c = configured[teller];
    bands[teller] = Array.isArray(c) && c.length === 2 ? (c as Band) : defaultBand(teller);
  }
  return bands;
}

/**
 * Count a period's slots per counter, keyed the way the solver keys them
 * (by shift_type.teller, not shift_type_id).
 */
export function countSlotsByTeller(periodId: string): Record<Teller, number> {
  const rows = db
    .prepare(
      `SELECT st.teller, COUNT(*) as count
       FROM dienstrooster_shift_slot s
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE s.period_id = ?
       GROUP BY st.teller`
    )
    .all(periodId) as Array<{ teller: string; count: number }>;

  const counts: Record<Teller, number> = { AVOND: 0, WEEKEND: 0, FEESTDAG: 0 };
  for (const row of rows) {
    if (TELLERS.includes(row.teller as Teller)) counts[row.teller as Teller] = row.count;
  }
  return counts;
}
