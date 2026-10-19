/**
 * The deelnamefactor of a person, worked out from what they filled in
 * themselves instead of typed in by the planner: the part-time days of their
 * Deeltijd step (docs/development/roster-rules.md, "Deelnamefactor").
 *
 * - One day every week off is 0,8, one day every other week 0,9, none 1,0; a
 *   pattern that holds for part of the period counts pro rata; never below
 *   0,2. The very rule the AIOS's fte follows (lib/aiosFte.ts): a copy, so
 *   the achterwacht does not depend on the AIOS's code (lib/deelnamefactor.
 *   test.ts holds the two together).
 * - Unknown until the person handed in their preferences for the period: a
 *   "Voltijd" for someone who has not filled in anything yet would be a
 *   guess. The solver does not wait for that: it takes what the Deeltijd
 *   step holds (1,0 without part-time days), as the AIOS's solver does.
 *
 * The column deelnamefactor of pool_membership is no longer read or written
 * (0.93.0): it stays in the table, always 1,0.
 */

import { db } from '@/db/client';
import { parseISO } from '@/lib/holidays';

export interface DeeltijdPatroon {
  frequentie: 'ELKE_WEEK' | 'EVEN_WEKEN' | 'ONEVEN_WEKEN';
  geldig_vanaf: string;
  geldig_tot: string;
}

const MINDER: Record<DeeltijdPatroon['frequentie'], number> = { ELKE_WEEK: 0.2, EVEN_WEKEN: 0.1, ONEVEN_WEKEN: 0.1 };

function dagenTussen(van: string, tot: string): number {
  return Math.round((parseISO(tot).getTime() - parseISO(van).getTime()) / 86_400_000) + 1;
}

/** The deelnamefactor over [van, tot] from part-time patterns, to two decimals. */
export function afgeleideDeelnamefactor(patronen: readonly DeeltijdPatroon[], van: string, tot: string): number {
  const totaal = dagenTussen(van, tot);
  let factor = 1;
  for (const p of patronen) {
    const begin = p.geldig_vanaf > van ? p.geldig_vanaf : van;
    const eind = p.geldig_tot < tot ? p.geldig_tot : tot;
    if (eind < begin) continue;
    factor -= MINDER[p.frequentie] * (dagenTussen(begin, eind) / totaal);
  }
  // Four part-time days a week is not a participant's; never zero or below.
  return Math.max(0.2, Math.round(factor * 100) / 100);
}

/** The factor of each person over a period, from their part-time patterns (1,0 without). */
export function laadAfgeleideDeelnamefactoren(personIds: readonly string[], period: { start_datum: string; eind_datum: string }): Map<string, number> {
  const uit = new Map<string, number>();
  if (personIds.length === 0) return uit;
  const rijen = db
    .prepare(
      `SELECT person_id, frequentie, geldig_vanaf, geldig_tot FROM dienstrooster_parttime_pattern
       WHERE person_id IN (${personIds.map(() => '?').join(',')}) AND geldig_vanaf <= ? AND geldig_tot >= ?`
    )
    .all(...personIds, period.eind_datum, period.start_datum) as Array<DeeltijdPatroon & { person_id: string }>;
  const perPersoon = new Map<string, DeeltijdPatroon[]>();
  for (const r of rijen) perPersoon.set(r.person_id, [...(perPersoon.get(r.person_id) ?? []), r]);
  for (const id of personIds) uit.set(id, afgeleideDeelnamefactor(perPersoon.get(id) ?? [], period.start_datum, period.eind_datum));
  return uit;
}

/**
 * The period a pool's participants are dealing with: the active one (the
 * invitations went out last), otherwise the one still being rostered.
 * Undefined when there is none.
 */
export function relevantePeriode(poolId: string): { id: string; start_datum: string; eind_datum: string } | undefined {
  const actief = db
    .prepare(
      `SELECT id, start_datum, eind_datum FROM dienstrooster_schedule_period
       WHERE pool_id = ? AND uitgenodigd_op IS NOT NULL AND verwijderd_op IS NULL
       ORDER BY uitgenodigd_op DESC, aangemaakt_op DESC LIMIT 1`
    )
    .get(poolId) as { id: string; start_datum: string; eind_datum: string } | undefined;
  if (actief) return actief;
  return db
    .prepare(
      `SELECT id, start_datum, eind_datum FROM dienstrooster_schedule_period
       WHERE pool_id = ? AND status IN ('OPEN', 'GESLOTEN', 'GEGENEREERD') AND verwijderd_op IS NULL
       ORDER BY start_datum DESC LIMIT 1`
    )
    .get(poolId) as { id: string; start_datum: string; eind_datum: string } | undefined;
}

/**
 * What "Personeel beheren" shows per person: the factor, or null (nog
 * onbekend) while they have not handed in their preferences for the period
 * the pool is dealing with.
 */
export function deelnamefactorVoorLijst(poolId: string, personIds: readonly string[]): Map<string, number | null> {
  const uit = new Map<string, number | null>(personIds.map((id) => [id, null]));
  const periode = relevantePeriode(poolId);
  if (!periode || personIds.length === 0) return uit;
  const ingediend = new Set(
    (
      db
        .prepare(
          `SELECT person_id FROM dienstrooster_submission
           WHERE schedule_period_id = ? AND status = 'BEVESTIGD' AND person_id IN (${personIds.map(() => '?').join(',')})`
        )
        .all(periode.id, ...personIds) as Array<{ person_id: string }>
    ).map((r) => r.person_id)
  );
  const factoren = laadAfgeleideDeelnamefactoren([...ingediend], periode);
  for (const id of ingediend) uit.set(id, factoren.get(id) ?? 1);
  return uit;
}

