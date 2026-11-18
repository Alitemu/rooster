import { db } from '@/db/client';

/**
 * Half a place: two part-time days every week and one every other week, over
 * the whole period of the tests. The deelnamefactor follows from the
 * part-time days (lib/deelnamefactor.ts), so a test that needs a part-timer
 * gives them these instead of a stored factor.
 *
 * The rows reference the person: delete them (deeltijdOpruimen) before the
 * person.
 */
export function halveDeelname(personId: string): void {
  for (const [weekdag, frequentie] of [
    ['MA', 'ELKE_WEEK'],
    ['DI', 'ELKE_WEEK'],
    ['WO', 'EVEN_WEKEN'],
  ]) {
    db.prepare(
      `INSERT INTO dienstrooster_parttime_pattern
         (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, ?, '2020-01-01', '2100-12-31', ?, datetime('now'))`
    ).run(crypto.randomUUID(), personId, weekdag, frequentie, personId);
  }
}

export function deeltijdOpruimen(personId: string): void {
  db.prepare('DELETE FROM dienstrooster_parttime_pattern WHERE person_id = ?').run(personId);
}
