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
import { combinedMembership } from '@/lib/coverageFactor';
import { afgeleideDeelnamefactor, bevrorenFactoren, laadParttimePatronen } from '@/lib/deelnamefactor';
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

// Pure, so the browser can read it too (lib/windowWeeks.ts).
export { resolveWindowWeeks, type WindowWeeksConfig } from './windowWeeks';

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
 * The band is the two whole numbers around the average, [floor, floor+1]:
 * a fractional average is [floor, ceil], and an exact whole-number average
 * still gets a real two-value band ([n, n+1]) instead of collapsing to
 * [n, n]. (It once jumped to [floor+2, floor+3] from x,5 upwards. With
 * an average of 2,5 that asked 4 or 5 of everyone, more shifts than the
 * period had, so nobody could end up inside it.)
 */
export function resolveBands(
  config: Record<string, unknown>,
  slotCountByTeller: Record<Teller, number>,
  peopleCount: number
): BandsByTeller {
  const defaultBand = (teller: Teller): Band => {
    const total = slotCountByTeller[teller];
    if (total <= 0) return [0, 0];
    // peopleCount is the effective headcount (effectiveHeadcount), which
    // can be a fraction: two people who are each there half the period
    // count as one.
    const avg = peopleCount > 0 ? total / peopleCount : total;
    const n = Math.floor(avg);
    return [n, n + 1];
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

/** One pool membership row, the way the period queries read it. */
export interface MembershipRow {
  id: string;
  deelnamefactor: number;
  geldig_vanaf: string;
  geldig_tot: string;
}

/**
 * A person's part in one period: every membership of theirs that overlaps
 * it, together (lib/coverageFactor.ts combinedMembership). dekking is the
 * part of the period they are a member, deelnamefactor their factor
 * weighted over it. What everything below scales by.
 */
export interface PeriodMember {
  id: string;
  dekking: number;
  deelnamefactor: number;
}

/**
 * Membership rows to one PeriodMember per person, in the order each person
 * first appears. Someone who stopped and came back within the period has
 * two rows; picking one of them (the last, as every caller used to) left
 * the other's weeks out of their streefbereik (audit 7).
 */
export function combineMemberships<R extends MembershipRow>(
  rows: R[],
  period: { start_datum: string; eind_datum: string }
): Array<PeriodMember & Omit<R, keyof MembershipRow>> {
  const byPerson = new Map<string, R[]>();
  for (const row of rows) byPerson.set(row.id, [...(byPerson.get(row.id) ?? []), row]);
  return [...byPerson.values()].map((own) => {
    const { id, deelnamefactor: _f, geldig_vanaf: _v, geldig_tot: _t, ...rest } = own[own.length - 1];
    return { ...rest, id, ...combinedMembership(own, period.start_datum, period.eind_datum) };
  });
}

/**
 * The active participants of a period: everyone in its pool with a
 * membership overlapping it, one PeriodMember each. The one query behind
 * generate-roster, the targets, the publication check, carry-over, the
 * fellow summary and the capacity check, so none of them can count a
 * person differently.
 */
export function loadPeriodMembers(
  period: {
    /** With it, the factors held when the roster was made count (lib/deelnamefactor.ts); without, those of now. */
    id?: string;
    pool_id: string;
    start_datum: string;
    eind_datum: string;
  },
  opties: { vers?: boolean } = {}
): Array<PeriodMember & { codenaam: string }> {
  const rows = db
    .prepare(
      `SELECT p.id, p.codenaam, pm.deelnamefactor, pm.geldig_vanaf, pm.geldig_tot
       FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<MembershipRow & { codenaam: string }>;
  // The deelnamefactor is the person's own, from their part-time days
  // (lib/deelnamefactor.ts), not the column of the membership: over the days
  // of each membership within the period, so combineMemberships weighs them
  // by those days and a part-time pattern that follows a partial membership
  // is not diluted by the days outside it.
  const patronen = laadParttimePatronen([...new Set(rows.map((r) => r.id))], period.start_datum, period.eind_datum);
  // Once the roster is made, the factor of that moment; `vers` is the generation itself, which makes a new one.
  const vast = period.id && !opties.vers ? bevrorenFactoren(period.id) : new Map<string, number>();
  return combineMemberships(
    rows.map((r) => ({
      ...r,
      deelnamefactor: vast.get(r.id) ?? afgeleideDeelnamefactor(
        patronen.get(r.id) ?? [],
        r.geldig_vanaf > period.start_datum ? r.geldig_vanaf : period.start_datum,
        r.geldig_tot < period.eind_datum ? r.geldig_tot : period.eind_datum
      ),
    })),
    period
  );
}

/**
 * How many people a period's shifts are really shared by: each member
 * counts for the part of the period they are a member (dekking), and
 * under NAAR_RATO for their deelnamefactor as well - exactly the two
 * factors scaledBandForMember then scales each person's band by.
 *
 * The band used to be worked out over the plain headcount. With someone
 * joining or leaving halfway (or a part-timer under NAAR_RATO) everyone's
 * maximum then added up to fewer shifts than there were, and since the
 * solver never goes past a maximum, shifts stayed empty that others had
 * room for (audit 6: 30 people, 110 avonddiensten, 6 of them half the
 * period - bereik 3 of 4, maximums together 108, 2 shifts unfilled). Over
 * the effective headcount the maximums always cover every shift and the
 * minimums never ask for more than there are (lib/calendarRules.test.ts).
 */
export function effectiveHeadcount(members: PeriodMember[], distributionMode: string): number {
  return members.reduce((sum, m) => sum + m.dekking * (distributionMode === 'NAAR_RATO' ? m.deelnamefactor : 1), 0);
}

/**
 * A period's bands together with the exact share they were rounded from (2.5.0).
 *
 * `aandeel` is what one member present the whole period at factor 1 gets on
 * average: the counter's shifts over the effective headcount (the weekend's
 * over the non-fellows). It is null where the ruleset names the band itself:
 * then the planner's band is the truth and its midpoint the share.
 */
export interface PeriodBands {
  bands: BandsByTeller;
  aandeel: Record<Teller, number | null>;
}

/**
 * A single member's [min, max] for one counter, before the ledger delta (2.5.0).
 *
 * Someone present the whole period at factor 1 gets the period's band as it
 * is: the band the ruleset names, literally (the planner's choice, 2.5.0),
 * also with fellows; or the derived one. Everyone else (dekking below 1, or
 * under NAAR_RATO a deelnamefactor below 1) gets their own share in
 * proportion, rounded once: x or x+1, never three values.
 *
 * It used to scale the band's two ends, the minimum down and the maximum up,
 * at every factor: [1, 2] became "1 tot en met 3" for the others when there
 * were fellows, and [2, 3] at 0.7 "1 tot en met 3" for a part-timer. A band
 * of three values is no target (the planner, November 2026).
 *
 * The share is the exact one where there is one: the maximums of a derived
 * band then always add up to every shift (floor(s) + 1 > s), and the
 * minimums never to more than there are (lib/calendarRules.test.ts). A
 * named band has none: its midpoint stands in, and whether the maximums
 * cover every shift is the planner's (lib/bandShortfall.ts says so before
 * generating). A hair over, so 0.7 x (2 + 3) / 2 x 4 / 1.4 lands on the
 * whole number it means; not rounded to hundredths, which could put a
 * minimum above the share and the minimums together above the shifts.
 *
 * The app works it out and sends it to the solver per person (generate-roster,
 * band_overrides), so the solver's own scaling is not used for the achterwacht's
 * roster: there is one calculation, here.
 */
export function scaledBandForMember(period: PeriodBands, teller: Teller, member: PeriodMember, distributionMode: string): Band {
  const [min, max] = period.bands[teller];
  const factor = member.dekking * (distributionMode === 'NAAR_RATO' ? member.deelnamefactor : 1);
  if (factor >= 1) return [min, max];
  if (max <= 0) return [0, 0];
  const share = (period.aandeel[teller] ?? (min + max) / 2) * factor;
  const n = Math.floor(share + 1e-9);
  return [n, n + 1];
}

/**
 * The period's bands with its fellows (lib/fellows.ts) taken into account.
 *
 * Fellows don't do weekends, so the weekend shifts are shared by the
 * others only:
 * - a band the ruleset names explicitly is kept as it is (2.5.0, the
 *   planner's choice): it is what someone present the whole period gets,
 *   fellows or not. It used to be raised by everyone / the others, which
 *   made a band of three values; whether it still holds every weekend
 *   shift, lib/bandShortfall.ts tells the planner before generating;
 * - without one, the usual default is worked out over the non-fellows.
 * AVOND and FEESTDAG are unchanged: fellows do those like everyone else.
 */
export function resolvePeriodTargets(
  config: Record<string, unknown>,
  slotCountByTeller: Record<Teller, number>,
  members: PeriodMember[],
  fellowIds: ReadonlySet<string>,
  distributionMode: string
): PeriodBands {
  const everyone = effectiveHeadcount(members, distributionMode);
  const bands = resolveBands(config, slotCountByTeller, everyone);
  const others = effectiveHeadcount(
    members.filter((m) => !fellowIds.has(m.id)),
    distributionMode
  );
  const fellows = members.some((m) => fellowIds.has(m.id)) && others > 0;
  const key: Record<Teller, string> = { AVOND: 'bandAvond', WEEKEND: 'bandWeekend', FEESTDAG: 'bandFeestdag' };
  const named = (teller: Teller) => {
    const c = config[key[teller]];
    return Array.isArray(c) && c.length === 2;
  };
  const share = (teller: Teller, people: number): number | null => {
    if (named(teller)) return null;
    const total = slotCountByTeller[teller];
    if (total <= 0) return 0;
    return people > 0 ? total / people : total;
  };
  if (fellows && !named('WEEKEND')) bands.WEEKEND = resolveBands({}, slotCountByTeller, others).WEEKEND;
  return {
    bands,
    aandeel: {
      AVOND: share('AVOND', everyone),
      WEEKEND: share('WEEKEND', fellows ? others : everyone),
      FEESTDAG: share('FEESTDAG', everyone),
    },
  };
}

/** resolvePeriodTargets' bands alone, for what shows or checks the period's band itself. */
export function resolvePeriodBands(
  config: Record<string, unknown>,
  slotCountByTeller: Record<Teller, number>,
  members: PeriodMember[],
  fellowIds: ReadonlySet<string>,
  distributionMode: string
): BandsByTeller {
  return resolvePeriodTargets(config, slotCountByTeller, members, fellowIds, distributionMode).bands;
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
  /** The band before the saldo: the period's, scaled for this person (2.2.0, for the planner's table). */
  basis?: Band;
  /** The saldo folded in: beginsaldo, carry-over and correcties of this period together (2.2.0). */
  saldo?: number;
  /**
   * The part this person counts for, below 1 only: dekking times, under NAAR_RATO, the deelnamefactor (2.6.1). Their
   * basis is then their own share in proportion (scaledBandForMember), which the planner's table says.
   */
  factor?: number;
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

  const members = loadPeriodMembers(period);
  if (members.length === 0) return result;

  const fellows = getFellowIds(periodId);
  const released = releasedWeekendDays(periodId);
  const config = resolveRulesetConfig(period);
  const distributionMode = typeof config.distributionMode === 'string' ? config.distributionMode : 'GELIJK';
  const bands = resolvePeriodTargets(config, countSlotsByTeller(periodId), members, fellows, distributionMode);

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
    const factor = member.dekking * (distributionMode === 'NAAR_RATO' ? member.deelnamefactor : 1);
    const deel = factor < 1 ? { factor } : {};
    for (const teller of TELLERS) {
      const scaled = scaledBandForMember(bands, teller, member, distributionMode);
      if (teller === 'WEEKEND' && fellows.has(member.id)) {
        const [min, max] = fellowWeekendBand(scaled, released.get(member.id) ?? 0);
        byTeller[teller] = { min, max, fellow: true, basis: scaled, saldo: 0, ...deel };
        continue;
      }
      const delta = deltas.get(`${member.id}|${teller}`) || 0;
      // A credit bigger than the bereik pulls the ceiling below zero: nobody
      // has fewer than none, so zero shifts is then exactly right (the solver
      // lets such a person end on zero as well, solver/constraints.py).
      byTeller[teller] = {
        min: Math.max(0, scaled[0] + delta),
        max: Math.max(0, scaled[1] + delta),
        fellow: false,
        basis: scaled,
        saldo: delta,
        ...deel,
      };
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
