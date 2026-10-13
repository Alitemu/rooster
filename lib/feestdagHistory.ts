/**
 * Feestdagdiensten over the years.
 *
 * What matters is how many feestdagdiensten everyone gets over the years,
 * not which feestdag (the planner's words, after audit 10). A period has
 * few of them - 7 for 15 people from January to September, so everyone's
 * band is 0 or 1 - and the overloop (lib/carryOver.ts) only books what
 * falls outside a band: who got the one and who got none was forgotten,
 * and the next period could pick the same people again.
 *
 * So the app keeps the score itself, from the rosters it has: for every
 * published period of the pool before this one (outside the trash), each
 * member's fair share of its feestdagdiensten - in proportion to the part
 * of the period they were a member, and under NAAR_RATO their
 * deelnamefactor, the same weights the bands use (effectiveHeadcount) -
 * minus the number they actually did. Summed, that is how far someone is
 * behind (positive) or ahead (negative). A newcomer starts even, and so
 * does everyone at the pool's first period here.
 *
 * generate-roster sends the solver, per member, that plus their fair share
 * of this period (`feestdag_targets`); the solver gives the feestdagen to
 * whoever is furthest from it, within the bands, never on a blocked day,
 * and before liever-niet (solver/objective.py
 * add_feestdag_history_objective).
 *
 * Rosters only: the per-feestdag history the setup wizard used to import
 * (holiday_history) says which feestdag, not how many out of how many.
 */

import { db } from '@/db/client';
import { loadPeriodMembers, resolveRulesetConfig, type PeriodMember } from '@/lib/rosterBands';
import { publishedPeriodsBefore } from '@/lib/previousPeriod';

interface PeriodRow {
  id: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
  bevroren_ruleset_json: string | null;
}

function weight(member: PeriodMember, distributionMode: string): number {
  return member.dekking * (distributionMode === 'NAAR_RATO' ? member.deelnamefactor : 1);
}

/** The period's feestdagdiensten: every person a feestdag slot needs. */
function feestdagDiensten(periodId: string): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(s.benodigd_aantal_personen), 0) AS n
         FROM dienstrooster_shift_slot s
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         WHERE s.period_id = ? AND st.teller = 'FEESTDAG'`
      )
      .get(periodId) as { n: number }
  ).n;
}

/** Each member's fair share of the period's feestdagdiensten. */
export function feestdagShares(period: PeriodRow): Map<string, number> {
  const members = loadPeriodMembers(period);
  const config = resolveRulesetConfig(period);
  const mode = typeof config.distributionMode === 'string' ? config.distributionMode : 'GELIJK';
  const total = members.reduce((sum, m) => sum + weight(m, mode), 0);
  const diensten = feestdagDiensten(period.id);
  return new Map(members.map((m) => [m.id, total > 0 ? (diensten * weight(m, mode)) / total : 0]));
}

/**
 * Per person how many feestdagdiensten they are behind (positive) or
 * ahead (negative) over every published period of the pool before
 * `beforeDate`. Only people who took part in one of them appear.
 */
export function feestdagAchterstand(poolId: string, beforeDate: string): Map<string, number> {
  const achterstand = new Map<string, number>();
  const done = db.prepare(
    `SELECT a.person_id, COUNT(*) AS n
     FROM dienstrooster_assignment a
     JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
     JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
     WHERE a.schedule_version_id = ? AND st.teller = 'FEESTDAG'
     GROUP BY a.person_id`
  );
  for (const period of publishedPeriodsBefore(poolId, beforeDate)) {
    for (const [personId, share] of feestdagShares(period)) {
      achterstand.set(personId, (achterstand.get(personId) ?? 0) + share);
    }
    for (const row of done.all(period.id) as Array<{ person_id: string; n: number }>) {
      achterstand.set(row.person_id, (achterstand.get(row.person_id) ?? 0) - row.n);
    }
  }
  return achterstand;
}

/**
 * What generate-roster sends as `feestdag_targets`: per member of this
 * period their fair share of its feestdagdiensten plus what they are
 * behind from before. Rounded to hundredths: the solver works in whole
 * shifts anyway.
 */
export function feestdagTargets(periodId: string): Record<string, number> {
  const period = db
    .prepare('SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as PeriodRow | undefined;
  if (!period) return {};
  const achterstand = feestdagAchterstand(period.pool_id, period.start_datum);
  const targets: Record<string, number> = {};
  for (const [personId, share] of feestdagShares(period)) {
    targets[personId] = Math.round((share + (achterstand.get(personId) ?? 0)) * 100) / 100;
  }
  return targets;
}
