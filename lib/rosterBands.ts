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
import { computeCoverageFactor } from '@/lib/coverageFactor';
import { getFellowIds, releasedWeekendDays } from '@/lib/fellows';

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

export interface CoverageAwareMember {
  deelnamefactor: number;
  geldig_vanaf: string;
  geldig_tot: string;
}

/**
 * A single member's effective [min, max] for one counter, scaled from the
 * period's flat band exactly the way solver/constraints.py's
 * add_band_constraints does - coverage_factor always applied first
 * (unconditional - a mid-period joiner/leaver is a structural fact, not a
 * distribution_mode-gated policy choice), then the NAAR_RATO deelnamefactor
 * scaling only when distribution_mode asks for it. floor(min)/ceil(max) at
 * each step keeps the band width >= 1 whenever the un-scaled band already
 * had one, instead of both ends rounding the same way and collapsing it to
 * a single value.
 *
 * Extracted out of lib/publicationCheck.ts (which used to carry this
 * scaling as its own private closure) so the pre-publication gate and
 * anything else that needs a real person's target - not just the period's
 * flat band - can never disagree about what that target is.
 */
export function scaledBandForMember(
  bands: BandsByTeller,
  teller: Teller,
  member: CoverageAwareMember,
  period: { start_datum: string; eind_datum: string },
  distributionMode: string
): Band {
  const [baseMin, baseMax] = bands[teller];

  const coverageFactor = computeCoverageFactor(
    member.geldig_vanaf,
    member.geldig_tot,
    period.start_datum,
    period.eind_datum
  );
  let min = Math.floor(baseMin * coverageFactor);
  let max = Math.max(min, Math.ceil(baseMax * coverageFactor));

  if (distributionMode === 'NAAR_RATO') {
    min = Math.floor(min * member.deelnamefactor);
    max = Math.max(min, Math.ceil(max * member.deelnamefactor));
  }

  return [min, max];
}

/**
 * The period's bands with its fellows (lib/fellows.ts) taken into account.
 *
 * Fellows don't do weekends, so the weekend shifts are shared by the
 * others only and their WEEKEND band goes up:
 * - a band the ruleset names explicitly (set when the period was created,
 *   over everyone) is scaled by people / (people - fellows), floor for the
 *   minimum and ceil for the maximum like every other band scaling here;
 * - without one, the usual default is worked out over the non-fellows.
 * AVOND and FEESTDAG are unchanged: fellows do those like everyone else.
 */
export function resolvePeriodBands(
  config: Record<string, unknown>,
  slotCountByTeller: Record<Teller, number>,
  peopleCount: number,
  fellowCount: number
): BandsByTeller {
  const bands = resolveBands(config, slotCountByTeller, peopleCount);
  const others = peopleCount - fellowCount;
  if (fellowCount <= 0 || others <= 0) return bands;

  const configured = config.bandWeekend;
  if (Array.isArray(configured) && configured.length === 2) {
    const factor = peopleCount / others;
    const min = Math.floor(bands.WEEKEND[0] * factor);
    bands.WEEKEND = [min, Math.max(min, Math.ceil(bands.WEEKEND[1] * factor))];
  } else {
    bands.WEEKEND = resolveBands({}, slotCountByTeller, others).WEEKEND;
  }
  return bands;
}

/**
 * A fellow's WEEKEND band: nothing is expected of them, and they can get
 * at most as many as they left unblocked themselves, never more than
 * anyone else's maximum. The ledger does not apply to it: a weekend saldo
 * waits until they are no longer a fellow (lib/carryOver.ts).
 */
export function fellowWeekendBand(scaled: Band, released: number): Band {
  return [0, Math.max(0, Math.min(released, scaled[1]))];
}

export interface MemberTarget {
  min: number;
  max: number;
  /** A fellow's WEEKEND target (fellowWeekendBand). */
  fellow: boolean;
}

/**
 * Every active pool member's target per counter for one period: the
 * period's bands (resolvePeriodBands), scaled per person
 * (scaledBandForMember), the ledger delta folded in, and a fellow's
 * WEEKEND replaced by fellowWeekendBand. The one answer to "what is this
 * person's streefbereik", shared by the publication check, the band room
 * shown when filling a gap by hand and the participant's own roster, so
 * none of them can disagree with the others or with the solver.
 */
export function computeMemberTargets(periodId: string): Map<string, Record<Teller, MemberTarget>> {
  const period = db
    .prepare(
      `SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json
       FROM dienstrooster_schedule_period WHERE id = ?`
    )
    .get(periodId) as
    | { id: string; pool_id: string; start_datum: string; eind_datum: string; bevroren_ruleset_json: string | null }
    | undefined;

  const result = new Map<string, Record<Teller, MemberTarget>>();
  if (!period) return result;

  const members = db
    .prepare(
      `SELECT p.id, pm.deelnamefactor, pm.geldig_vanaf, pm.geldig_tot
       FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<CoverageAwareMember & { id: string }>;
  if (members.length === 0) return result;

  const fellows = getFellowIds(periodId);
  const released = releasedWeekendDays(periodId);
  const config = resolveRulesetConfig(period);
  const distributionMode = typeof config.distributionMode === 'string' ? config.distributionMode : 'GELIJK';
  const bands = resolvePeriodBands(
    config,
    countSlotsByTeller(periodId),
    members.length,
    members.filter((m) => fellows.has(m.id)).length
  );

  const deltas = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT person_id, teller, SUM(delta) as total
       FROM dienstrooster_ledger_entry
       WHERE geldt_voor_periode_id = ?
       GROUP BY person_id, teller`
    )
    .all(periodId) as Array<{ person_id: string; teller: string; total: number }>) {
    deltas.set(`${row.person_id}|${row.teller}`, row.total || 0);
  }

  for (const member of members) {
    const byTeller = {} as Record<Teller, MemberTarget>;
    for (const teller of TELLERS) {
      const scaled = scaledBandForMember(bands, teller, member, period, distributionMode);
      if (teller === 'WEEKEND' && fellows.has(member.id)) {
        const [min, max] = fellowWeekendBand(scaled, released.get(member.id) ?? 0);
        byTeller[teller] = { min, max, fellow: true };
        continue;
      }
      const delta = deltas.get(`${member.id}|${teller}`) || 0;
      byTeller[teller] = { min: scaled[0] + delta, max: scaled[1] + delta, fellow: false };
    }
    result.set(member.id, byTeller);
  }
  return result;
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

export interface PersonBandStatus {
  count: number; // this person's actual assignment count for this counter, this period
  max: number; // scaledBandForMember's max, ledger delta already folded in - the same
  // "actual_max" the solver itself enforces, so `count > max` here means
  // literally the same thing it means in solver/constraints.py.
  fellow: boolean; // a fellow's WEEKEND (fellowWeekendBand): below it is expected, not a shortfall
}

/**
 * Every active pool member's real count vs. effective ceiling, per counter,
 * for one period - computeMemberTargets' ceilings next to what each person
 * actually has.
 *
 * Shared by lib/rebalanceSuggestions.ts (who's over, who has room to
 * absorb a moved dienst) and lib/rosterGaps.ts (showing a candidate's
 * band room when a planner is filling a gap by hand) - both need the
 * exact same number for "how full is this person", so it's computed once
 * here instead of twice.
 */
export function computeBandStatusByPerson(periodId: string): Map<string, Record<Teller, PersonBandStatus>> {
  const result = new Map<string, Record<Teller, PersonBandStatus>>();
  const targets = computeMemberTargets(periodId);
  if (targets.size === 0) return result;

  const counts = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT a.person_id, st.teller, COUNT(*) as count
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = ?
       GROUP BY a.person_id, st.teller`
    )
    .all(periodId) as Array<{ person_id: string; teller: string; count: number }>) {
    counts.set(`${row.person_id}|${row.teller}`, row.count);
  }

  for (const [personId, target] of targets) {
    const byTeller = {} as Record<Teller, PersonBandStatus>;
    for (const teller of TELLERS) {
      byTeller[teller] = {
        count: counts.get(`${personId}|${teller}`) || 0,
        max: target[teller].max,
        fellow: target[teller].fellow,
      };
    }
    result.set(personId, byTeller);
  }

  return result;
}
