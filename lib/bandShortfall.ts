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
  resolvePeriodBands,
  resolveRulesetConfig,
  scaledBandForMember,
  type BandsByTeller,
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

/**
 * Per counter where the members' maximums together (scaled band plus their
 * balance, a fellow's own weekend band) are fewer than the shifts: how many
 * they allow, how many there are, and - when the typed band is lower than
 * the one the app would choose for these members itself - that band, in the
 * same terms as the "Venster en streefbereik" inputs.
 */
export function computeBandShortfall(args: {
  config: Record<string, unknown>;
  bands: BandsByTeller;
  slotCountByTeller: Record<Teller, number>;
  members: PeriodMember[];
  balances: Record<string, Record<string, number>>;
  bandOverrides: Record<string, { WEEKEND: [number, number] }>;
  distributionMode: string;
}): BereikTekort {
  const { config, bands, slotCountByTeller, members, balances, bandOverrides, distributionMode } = args;
  const suggested = resolveBands({}, slotCountByTeller, effectiveHeadcount(members, distributionMode));
  const tekort: BereikTekort = {};
  for (const teller of TELLERS) {
    let maximaal = 0;
    for (const m of members) {
      const override = teller === 'WEEKEND' ? bandOverrides[m.id]?.WEEKEND : undefined;
      maximaal += override
        ? override[1]
        : Math.max(0, scaledBandForMember(bands, teller, m, distributionMode)[1] + (balances[m.id]?.[teller] ?? 0));
    }
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

/** Fellows' own weekend band (lib/fellows.ts), sent to the solver as band_overrides. */
export function fellowBandOverrides(
  periodId: string,
  bands: BandsByTeller,
  members: PeriodMember[],
  fellowIds: ReadonlySet<string>,
  distributionMode: string
): Record<string, { WEEKEND: [number, number] }> {
  const released = releasedWeekendDays(periodId);
  const overrides: Record<string, { WEEKEND: [number, number] }> = {};
  for (const m of members) {
    if (!fellowIds.has(m.id)) continue;
    overrides[m.id] = { WEEKEND: fellowWeekendBand(scaledBandForMember(bands, 'WEEKEND', m, distributionMode), released.get(m.id) ?? 0) };
  }
  return overrides;
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
  const bands = resolvePeriodBands(config, slotCountByTeller, members, fellowIds, distributionMode);

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
      bands,
      slotCountByTeller,
      members,
      balances,
      bandOverrides: fellowBandOverrides(periodId, bands, members, fellowIds, distributionMode),
      distributionMode,
    }),
  };
}
