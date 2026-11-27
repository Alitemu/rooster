/**
 * Whether the streefbereik can hold every shift of a period, before and
 * after generating.
 *
 * A period's streefbereik is required when it opens and the setup wizard
 * fills it in from the members there are at that moment; it stays frozen
 * with the period when the pool changes afterwards. The maximums of the
 * members together can then fall short of the shifts, and the solver -
 * which never goes past a maximum - leaves the rest empty, whatever the
 * method or the window (audit 9: 5-6 avonddiensten worked out for 30
 * people, generated for 15).
 *
 * computeBandShortfall is the one calculation: generate-roster reports it
 * with an unfilled result (`bereik_tekort`), and bandCheckForPeriod gives
 * the generation dialog the same answer before "Genereren" is pressed,
 * for the bands as typed there.
 */

import { db } from '@/db/client';
import {
  TELLERS,
  effectiveHeadcount,
  fellowWeekendBand,
  loadPeriodMembers,
  resolveBands,
  resolvePeriodTargets,
  resolveRulesetConfig,
  scaledBandForMember,
  type Band,
  type PeriodBands,
  type PeriodMember,
  type Teller,
} from '@/lib/rosterBands';
import { getFellowIds, releasedWeekendDays } from '@/lib/fellows';
import type { BereikTekort } from '@/lib/unfilledExplanation';

export const BAND_CONFIG_KEY: Record<Teller, 'bandAvond' | 'bandWeekend' | 'bandFeestdag'> = {
  AVOND: 'bandAvond',
  WEEKEND: 'bandWeekend',
  FEESTDAG: 'bandFeestdag',
};

/** Every member's band per counter, as the solver gets it (band_overrides). */
export type MemberBands = Record<string, Record<Teller, Band>>;

/**
 * Every member's band per counter, the ledger delta folded in: what the
 * solver holds each person to (2.5.0). Sent whole as band_overrides, which
 * the solver takes as it is (no scaling, no delta of its own; only what
 * the planner filled in by hand is taken off), so the band the planner
 * sees (computeMemberTargets, the same scaledBandForMember and the same
 * clamp at none) is the band the roster is made with. A fellow's weekend
 * is their own (fellowWeekendBand), without a delta.
 */
export function memberBands(
  periodId: string,
  period: PeriodBands,
  members: PeriodMember[],
  fellowIds: ReadonlySet<string>,
  distributionMode: string,
  balances: Record<string, Record<string, number>>
): MemberBands {
  const released = releasedWeekendDays(periodId);
  const out: MemberBands = {};
  for (const m of members) {
    const own = {} as Record<Teller, Band>;
    for (const teller of TELLERS) {
      const scaled = scaledBandForMember(period, teller, m, distributionMode);
      if (teller === 'WEEKEND' && fellowIds.has(m.id)) {
        own[teller] = fellowWeekendBand(scaled, released.get(m.id) ?? 0);
        continue;
      }
      // A credit bigger than the bereik pulls the ceiling below none: nobody has fewer than none.
      const delta = balances[m.id]?.[teller] ?? 0;
      own[teller] = [Math.max(0, scaled[0] + delta), Math.max(0, scaled[1] + delta)];
    }
    out[m.id] = own;
  }
  return out;
}

/**
 * Per counter where the members' maximums together (memberBands) are fewer
 * than the shifts: how many they allow, how many there are, and - when the
 * typed band is lower than the one the app would choose for these members
 * itself - that band, in the same terms as the "Venster en streefbereik"
 * inputs.
 */
export function computeBandShortfall(args: {
  config: Record<string, unknown>;
  slotCountByTeller: Record<Teller, number>;
  members: PeriodMember[];
  bands: MemberBands;
  distributionMode: string;
}): BereikTekort {
  const { config, slotCountByTeller, members, bands, distributionMode } = args;
  const suggested = resolveBands({}, slotCountByTeller, effectiveHeadcount(members, distributionMode));
  const tekort: BereikTekort = {};
  for (const teller of TELLERS) {
    let maximaal = 0;
    for (const m of members) maximaal += bands[m.id]?.[teller]?.[1] ?? 0;
    if (maximaal >= slotCountByTeller[teller]) continue;
    const configured = config[BAND_CONFIG_KEY[teller]];
    const voorgesteld = suggested[teller];
    tekort[teller] = {
      maximaal,
      diensten: slotCountByTeller[teller],
      ...(Array.isArray(configured) && voorgesteld[1] > Number(configured[1]) ? { voorgesteld } : {}),
    };
  }
  return tekort;
}

export type BandOverridesInput = Partial<Record<'bandAvond' | 'bandWeekend' | 'bandFeestdag', [number, number]>>;

/**
 * The shortfall for a period as it stands, with `typed` in place of the
 * frozen bands: what the generation dialog shows while the planner edits.
 * Null for a period that does not exist.
 */
export function bandCheckForPeriod(periodId: string, typed: BandOverridesInput = {}): { bereik_tekort: BereikTekort } | null {
  const period = db
    .prepare('SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as { id: string; pool_id: string; start_datum: string; eind_datum: string; bevroren_ruleset_json: string | null } | undefined;
  if (!period) return null;

  const config: Record<string, unknown> = { ...resolveRulesetConfig(period), ...typed };
  const slotCountByTeller: Record<Teller, number> = { AVOND: 0, WEEKEND: 0, FEESTDAG: 0 };
  for (const row of db
    .prepare(
      `SELECT st.teller, COUNT(*) AS n FROM dienstrooster_shift_slot s
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id WHERE s.period_id = ? GROUP BY st.teller`
    )
    .all(periodId) as Array<{ teller: Teller; n: number }>) {
    if (row.teller in slotCountByTeller) slotCountByTeller[row.teller] = row.n;
  }

  const members = loadPeriodMembers(period);
  const fellowIds = getFellowIds(periodId);
  const distributionMode = typeof config.distributionMode === 'string' ? config.distributionMode : 'GELIJK';
  const targets = resolvePeriodTargets(config, slotCountByTeller, members, fellowIds, distributionMode);

  const balances: Record<string, Record<string, number>> = {};
  for (const row of db
    .prepare(
      `SELECT person_id, teller, SUM(delta) AS total FROM dienstrooster_ledger_entry
       WHERE geldt_voor_periode_id = ? GROUP BY person_id, teller`
    )
    .all(periodId) as Array<{ person_id: string; teller: string; total: number }>) {
    (balances[row.person_id] ??= {})[row.teller] = row.total ?? 0;
  }

  return {
    bereik_tekort: computeBandShortfall({
      config,
      slotCountByTeller,
      members,
      bands: memberBands(periodId, targets, members, fellowIds, distributionMode, balances),
      distributionMode,
    }),
  };
}
