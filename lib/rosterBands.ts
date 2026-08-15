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

/**
 * Resolve the [min, max] band per counter for a period.
 *
 * A flat band for every counter is only feasible by coincidence - WEEKEND
 * and FEESTDAG have far fewer slots than AVOND - so when the ruleset
 * doesn't name a band explicitly we derive each counter's own band from
 * its actual average per person.
 */
export function resolveBands(
  config: Record<string, unknown>,
  slotCountByTeller: Record<Teller, number>,
  peopleCount: number
): BandsByTeller {
  const defaultBand = (teller: Teller): Band => {
    const avg = slotCountByTeller[teller] / Math.max(peopleCount, 1);
    return [Math.max(0, Math.floor(avg)), Math.max(0, Math.ceil(avg))];
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
