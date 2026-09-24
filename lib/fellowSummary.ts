/**
 * What the fellows (lib/fellows.ts) mean for one period, for the planner:
 * who they are, how many weekend days each left open, the raised weekend
 * band of everyone else, and whether the weekend/feestdag window still
 * fits now that fewer people share the weekends (lib/capacity.ts
 * checkWeekendCapacity). The window itself stays the planner's to set.
 */

import { db } from '@/db/client';
import { checkWeekendCapacity } from './capacity';
import { getFellowIds, releasedWeekendDays } from './fellows';
import { countSlotsByTeller, resolvePeriodBands, resolveRulesetConfig, resolveWindowWeeks, type Band } from './rosterBands';

export interface FellowSummary {
  fellows: Array<{ person_id: string; codenaam: string; vrije_weekenddagen: number }>;
  weekend: {
    /** Pool members who do weekends: everyone but the fellows. */
    mensen: number;
    /** Slots on a Saturday or Sunday, feestdagen included. */
    diensten: number;
    venster: number;
    past: boolean;
    voorgesteld_venster: number | null;
    /** The others' WEEKEND band at generation (resolvePeriodBands). */
    bereik: Band;
    /** The same band as if nobody were a fellow, to show the difference. */
    bereik_zonder_fellows: Band;
  };
}

export function fellowSummary(periodId: string, windowOverride?: number): FellowSummary | null {
  const period = db
    .prepare(
      `SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json
       FROM dienstrooster_schedule_period WHERE id = ?`
    )
    .get(periodId) as
    | { id: string; pool_id: string; start_datum: string; eind_datum: string; bevroren_ruleset_json: string | null }
    | undefined;
  if (!period) return null;

  const members = db
    .prepare(
      `SELECT DISTINCT p.id, p.codenaam FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1
       ORDER BY p.codenaam`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ id: string; codenaam: string }>;

  const fellowIds = getFellowIds(periodId);
  const released = releasedWeekendDays(periodId);
  const fellows = members
    .filter((m) => fellowIds.has(m.id))
    .map((m) => ({ person_id: m.id, codenaam: m.codenaam, vrije_weekenddagen: released.get(m.id) ?? 0 }));

  const config = resolveRulesetConfig(period);
  const counts = countSlotsByTeller(periodId);
  const window = windowOverride ?? resolveWindowWeeks(config).weekendFeestdag;
  const weekendSlots = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM dienstrooster_shift_slot s
         WHERE s.period_id = ? AND strftime('%w', s.datum) IN ('0', '6')`
      )
      .get(periodId) as { n: number }
  ).n;
  const days =
    Math.round((Date.parse(`${period.eind_datum}T00:00:00Z`) - Date.parse(`${period.start_datum}T00:00:00Z`)) / 86_400_000) + 1;
  const mensen = members.length - fellows.length;
  const capacity = checkWeekendCapacity(days / 7, window, mensen, weekendSlots);

  return {
    fellows,
    weekend: {
      mensen,
      diensten: weekendSlots,
      venster: window,
      past: capacity.passed,
      voorgesteld_venster: capacity.suggestedWindow,
      bereik: resolvePeriodBands(config, counts, members.length, fellows.length).WEEKEND,
      bereik_zonder_fellows: resolvePeriodBands(config, counts, members.length, 0).WEEKEND,
    },
  };
}
