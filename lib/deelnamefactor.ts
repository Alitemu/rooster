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
 * - Only Monday to Friday count: a part-time day means "I do not work this
 *   weekday" (lib/parttimeSync.ts PARTTIME_WEEKDAGEN), the weekend counter is
 *   separate. A Saturday or Sunday pattern from before that rule is left out.
 * - A weekday counts once. Two patterns of one weekday over the same days (the
 *   routes refuse them, rows from before may exist) are their union: every
 *   week beats every other week, even and odd weeks together are every week.
 * - Unknown until the person handed in their preferences for the period: a
 *   "Voltijd" for someone who has not filled in anything yet would be a
 *   guess. The solver does not wait for that: it takes what the Deeltijd
 *   step holds (1,0 without part-time days), as the AIOS's solver does.
 *
 * Held per period once its roster is made (dienstrooster_period_factor, bevrorenFactoren):
 * what the roster, its publication check and the carry-over count with is what
 * they counted with when it was made, however the part-time days change after.
 *
 * The column deelnamefactor of pool_membership is no longer read or written
 * (0.93.0): it stays in the table, always 1,0.
 */

import { db } from '@/db/client';
import { addDays, parseISO } from '@/lib/holidays';

export interface DeeltijdPatroon {
  weekdag: string;
  frequentie: 'ELKE_WEEK' | 'EVEN_WEKEN' | 'ONEVEN_WEKEN';
  geldig_vanaf: string;
  geldig_tot: string;
}

const MINDER: Record<DeeltijdPatroon['frequentie'], number> = { ELKE_WEEK: 0.2, EVEN_WEKEN: 0.1, ONEVEN_WEKEN: 0.1 };
const WERKDAGEN = ['MA', 'DI', 'WO', 'DO', 'VR'];

function dagenTussen(van: string, tot: string): number {
  return Math.round((parseISO(tot).getTime() - parseISO(van).getTime()) / 86_400_000) + 1;
}

/** The days of [van, tot] one pattern holds on: a whole range, not yet the weekday itself (the weight is per pattern, as in lib/aiosFte.ts). */
function dagenVan(p: DeeltijdPatroon, van: string, tot: string): number {
  const begin = p.geldig_vanaf > van ? p.geldig_vanaf : van;
  const eind = p.geldig_tot < tot ? p.geldig_tot : tot;
  return eind < begin ? 0 : dagenTussen(begin, eind);
}

/** The deelnamefactor over [van, tot] from part-time patterns, to two decimals. */
export function afgeleideDeelnamefactor(patronen: readonly DeeltijdPatroon[], van: string, tot: string): number {
  const totaal = dagenTussen(van, tot);
  let factor = 1;
  for (const dag of WERKDAGEN) {
    const eigen = patronen.filter((p) => p.weekdag === dag && dagenVan(p, van, tot) > 0);
    if (eigen.length === 0) continue;
    if (eigen.length === 1) {
      factor -= MINDER[eigen[0].frequentie] * (dagenVan(eigen[0], van, tot) / totaal);
      continue;
    }
    // More than one on this weekday: count each day of the range once, by what holds on it.
    let elke = 0;
    let even = 0;
    let oneven = 0;
    for (let d = van; d <= tot; d = addDays(d, 1)) {
      const dekt = eigen.filter((p) => p.geldig_vanaf <= d && d <= p.geldig_tot);
      if (dekt.some((p) => p.frequentie === 'ELKE_WEEK')) elke++;
      else {
        if (dekt.some((p) => p.frequentie === 'EVEN_WEKEN')) even++;
        if (dekt.some((p) => p.frequentie === 'ONEVEN_WEKEN')) oneven++;
      }
    }
    factor -= MINDER.ELKE_WEEK * (elke / totaal);
    factor -= MINDER.EVEN_WEKEN * (even / totaal);
    factor -= MINDER.ONEVEN_WEKEN * (oneven / totaal);
  }
  // Four part-time days a week is not a participant's; never zero or below.
  return Math.max(0.2, Math.round(factor * 100) / 100);
}

/** The part-time patterns of these people that hold on some day of [van, tot]. */
export function laadParttimePatronen(personIds: readonly string[], van: string, tot: string): Map<string, DeeltijdPatroon[]> {
  const perPersoon = new Map<string, DeeltijdPatroon[]>();
  if (personIds.length === 0) return perPersoon;
  const rijen = db
    .prepare(
      `SELECT person_id, weekdag, frequentie, geldig_vanaf, geldig_tot FROM dienstrooster_parttime_pattern
       WHERE person_id IN (${personIds.map(() => '?').join(',')}) AND geldig_vanaf <= ? AND geldig_tot >= ?`
    )
    .all(...personIds, tot, van) as Array<DeeltijdPatroon & { person_id: string }>;
  for (const r of rijen) perPersoon.set(r.person_id, [...(perPersoon.get(r.person_id) ?? []), r]);
  return perPersoon;
}

/** The factor of each person over a period, from their part-time patterns (1,0 without). */
export function laadAfgeleideDeelnamefactoren(personIds: readonly string[], period: { start_datum: string; eind_datum: string }): Map<string, number> {
  const uit = new Map<string, number>();
  const patronen = laadParttimePatronen(personIds, period.start_datum, period.eind_datum);
  for (const id of personIds) uit.set(id, afgeleideDeelnamefactor(patronen.get(id) ?? [], period.start_datum, period.eind_datum));
  return uit;
}

export interface PeriodeKeuze {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
}

/**
 * The period a pool's participants are dealing with: the active one (the
 * invitations went out last), otherwise the one still being rostered.
 * Undefined when there is none. The AIOS keeps the day of its invitations in
 * its own table (lib/aiosUitnodigen.ts), the achterwacht in the period row.
 */
export function relevantePeriode(poolId: string): PeriodeKeuze | undefined {
  const actief = db
    .prepare(
      `SELECT sp.id, sp.naam, sp.start_datum, sp.eind_datum, COALESCE(sp.uitgenodigd_op, ap.uitgenodigd_op) AS uitgenodigd
       FROM dienstrooster_schedule_period sp
       LEFT JOIN dienstrooster_aios_periode ap ON ap.period_id = sp.id
       WHERE sp.pool_id = ? AND COALESCE(sp.uitgenodigd_op, ap.uitgenodigd_op) IS NOT NULL AND sp.verwijderd_op IS NULL
       ORDER BY uitgenodigd DESC, sp.aangemaakt_op DESC LIMIT 1`
    )
    .get(poolId) as PeriodeKeuze | undefined;
  if (actief) return actief;
  return db
    .prepare(
      `SELECT id, naam, start_datum, eind_datum FROM dienstrooster_schedule_period
       WHERE pool_id = ? AND status IN ('OPEN', 'GESLOTEN', 'GEGENEREERD') AND verwijderd_op IS NULL
       ORDER BY start_datum DESC LIMIT 1`
    )
    .get(poolId) as PeriodeKeuze | undefined;
}

/** The period of this pool that runs exactly over these dates, if there is one (the wizard asks for its own). */
export function periodeMetDatums(poolId: string, start: string, eind: string): PeriodeKeuze | undefined {
  return db
    .prepare(
      `SELECT id, naam, start_datum, eind_datum FROM dienstrooster_schedule_period
       WHERE pool_id = ? AND start_datum = ? AND eind_datum = ? AND verwijderd_op IS NULL
       ORDER BY aangemaakt_op DESC LIMIT 1`
    )
    .get(poolId, start, eind) as PeriodeKeuze | undefined;
}

/**
 * What "Personeel beheren" shows per person: the factor, or null (nog
 * onbekend) while they have not handed in their preferences for the period
 * the pool is dealing with (`periode`: the one the caller names, such as the
 * wizard's own, otherwise relevantePeriode). `periode` of the answer is the
 * one it is about, so the list can say which.
 */
export function deelnamefactorVoorLijst(
  poolId: string,
  personIds: readonly string[],
  gekozen?: PeriodeKeuze
): { factoren: Map<string, number | null>; periode: PeriodeKeuze | undefined } {
  const factoren = new Map<string, number | null>(personIds.map((id) => [id, null]));
  const periode = gekozen ?? relevantePeriode(poolId);
  if (!periode || personIds.length === 0) return { factoren, periode };
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
  const afgeleid = laadAfgeleideDeelnamefactoren([...ingediend], periode);
  for (const id of ingediend) factoren.set(id, afgeleid.get(id) ?? 1);
  return { factoren, periode };
}

/**
 * The factors as they were when the roster of this period was made, per
 * person. Only while there is a roster (gegenereerd or gepubliceerd): before
 * it and after it is removed the factor follows the part-time days as they
 * are, and a generation that failed before any roster leaves nothing behind
 * that counts.
 */
export function bevrorenFactoren(periodId: string): Map<string, number> {
  const rijen = db
    .prepare(
      `SELECT f.person_id, f.factor FROM dienstrooster_period_factor f
       JOIN dienstrooster_schedule_period p ON p.id = f.period_id
       WHERE f.period_id = ? AND p.status IN ('GEGENEREERD', 'GEPUBLICEERD')`
    )
    .all(periodId) as Array<{ person_id: string; factor: number }>;
  return new Map(rijen.map((r) => [r.person_id, r.factor]));
}

/** Holds these factors for the period: what a roster made now counts with, until a new one is made or it is removed. */
export function legFactorenVast(periodId: string, leden: ReadonlyArray<{ id: string; deelnamefactor: number }>): void {
  db.transaction(() => {
    db.prepare('DELETE FROM dienstrooster_period_factor WHERE period_id = ?').run(periodId);
    const voeg = db.prepare('INSERT INTO dienstrooster_period_factor (id, period_id, person_id, factor) VALUES (?, ?, ?, ?)');
    for (const l of leden) voeg.run(crypto.randomUUID(), periodId, l.id, l.deelnamefactor);
  })();
}

export function wisBevrorenFactoren(periodId: string): void {
  db.prepare('DELETE FROM dienstrooster_period_factor WHERE period_id = ?').run(periodId);
}
