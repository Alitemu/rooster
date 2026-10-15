/**
 * Every day belongs to at most one period of a pool (audit 12).
 *
 * Opening rounds a period's start back to the Monday of its week. A next
 * period typed to start on Wednesday 1 September, after one that ran to
 * Sunday 5 September, began on Monday 30 August: that week had slots in
 * both periods, both rosters filled them, and two people stood on the same
 * achterwacht day. Nothing checked for overlap. Creating and opening a
 * period now refuse days another period of the pool already has - one past
 * CONCEPT (a draft has no slots yet and its dates are not final) and
 * outside the prullenbak - and so does restoring one from the prullenbak
 * (lib/periodTrash.ts, audit 13).
 *
 * An AIOS period is the exception to "a draft has no slots": it is one
 * quarter whose diensten are made with the period (lib/aiosSlots.ts), so
 * there a draft takes its days too, and a second period on the same
 * quarter is refused from the start.
 */

import { db } from '@/db/client';

export interface OverlappingPeriod {
  naam: string;
  start_datum: string;
  eind_datum: string;
  // The pool is an AIOS pool: its periods are quarters, not ISO weeks.
  aios: number;
}

/** The pool's other period sharing a day with start..eind (both inclusive), if any. */
export function overlappingPeriod(poolId: string, start: string, eind: string, exceptId?: string): OverlappingPeriod | undefined {
  return db
    .prepare(
      `SELECT sp.naam, sp.start_datum, sp.eind_datum, pl.type = 'AIOS' AS aios
       FROM dienstrooster_schedule_period sp
       JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
       WHERE sp.pool_id = ? AND sp.id != ? AND (sp.status != 'CONCEPT' OR pl.type = 'AIOS') AND sp.verwijderd_op IS NULL
         AND sp.start_datum <= ? AND sp.eind_datum >= ?
       ORDER BY sp.start_datum LIMIT 1`
    )
    .get(poolId, exceptId ?? '', eind, start) as OverlappingPeriod | undefined;
}

const datumTekst = (datum: string) =>
  new Date(`${datum}T12:00:00Z`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** What the planner is told, in Dutch. */
export function overlapMessage(other: OverlappingPeriod): string {
  return (
    `Deze periode overlapt met "${other.naam}" (${datumTekst(other.start_datum)} t/m ${datumTekst(other.eind_datum)}). ` +
    (other.aios
      ? 'Elke dag hoort bij één periode. Kies een ander kwartaal.'
      : 'Elke dag hoort bij één periode. Een periode begint altijd op de maandag van de week van de startdatum.')
  );
}
