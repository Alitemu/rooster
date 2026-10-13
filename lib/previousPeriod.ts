/**
 * The period before this one, and what a new period takes from it.
 *
 * Two things cross the boundary between periods: the overloop (each
 * person's balance, lib/carryOver.ts) and "Eerdere toewijzingen" - the
 * previous roster's last weeks, so the window rule holds across the
 * boundary in the solver and in the publication check alike.
 *
 * Both come from the pool's most recent published period that ended before
 * this one starts - and never from one in the prullenbak: a planner may
 * throw a published period away, participants lose it at once, and it
 * must not go on deciding the next period's balances and window until the
 * purge 30 days later quietly changes both (audit 10). Six places looked
 * it up themselves without that; they all ask findPreviousPublishedPeriod
 * now (lib/previousPeriod.test.ts holds them to it).
 */

import { db } from '@/db/client';
import { calculatePriorAssignmentRange, resolvePriorAssignmentWeeks } from '@/lib/priorAssignmentDerive';

export interface PreviousPeriodRow {
  id: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
  bevroren_ruleset_json: string | null;
}

/** The pool's most recent published period ending before `beforeDate`, outside the trash. */
export function findPreviousPublishedPeriod(poolId: string, beforeDate: string): PreviousPeriodRow | undefined {
  return db
    .prepare(
      `SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json
       FROM dienstrooster_schedule_period
       WHERE pool_id = ? AND status = 'GEPUBLICEERD' AND verwijderd_op IS NULL AND eind_datum < ?
       ORDER BY eind_datum DESC
       LIMIT 1`
    )
    .get(poolId, beforeDate) as PreviousPeriodRow | undefined;
}

export interface PriorRefresh {
  /** The period the rows come from now, if there is one. */
  previous: PreviousPeriodRow | undefined;
  /** The lookback window in that period, inclusive. */
  range: [string, string] | null;
  added: number;
  changed: number;
  removed: number;
}

/**
 * Brings this period's derived "Eerdere toewijzingen" (bron AFGELEID) in
 * line with the previous roster as it is now.
 *
 * They used to be a snapshot: derived once, and deriving again skipped
 * every day that already had a row. The next period is open for
 * preferences while the previous roster still runs, and its last weeks
 * change through swaps and sick leave like any other week - the solver
 * then planned around who used to work those days, and the publication
 * check judged the window against them too (audit 10). So: a day worked
 * by someone else now gets the new person, a day nobody works any more
 * loses its row, and a derived row from a period that is no longer the
 * previous one (thrown away, or a later one published since) goes.
 *
 * What the planner set by hand (HANDMATIG, including a day they cleared)
 * and rows marked unknown (ONBEKEND) are theirs and stay. Called by
 * "afleiden" and before every generation.
 */
export function refreshDerivedPriorAssignments(periodId: string, actorId: string, now: string = new Date().toISOString()): PriorRefresh {
  const period = db
    .prepare('SELECT id, pool_id, start_datum, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as { id: string; pool_id: string; start_datum: string; bevroren_ruleset_json: string | null } | undefined;
  if (!period) return { previous: undefined, range: null, added: 0, changed: 0, removed: 0 };

  const previous = findPreviousPublishedPeriod(period.pool_id, period.start_datum);
  const range = previous ? calculatePriorAssignmentRange(previous.eind_datum, resolvePriorAssignmentWeeks(period)) : null;

  // Who works each day of the lookback window now, one per day and
  // counter (the table holds one row per day and counter).
  const current = new Map<string, { datum: string; teller: string; iso_jaar: number; iso_week: number; person_id: string }>();
  if (previous && range) {
    const rows = db
      .prepare(
        `SELECT s.datum, st.teller, s.iso_jaar, s.iso_week, a.person_id
         FROM dienstrooster_assignment a
         JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         WHERE s.period_id = ? AND s.datum >= ? AND s.datum <= ?
         ORDER BY s.datum, st.teller, a.aangemaakt_op, a.id`
      )
      .all(previous.id, range[0], range[1]) as Array<{ datum: string; teller: string; iso_jaar: number; iso_week: number; person_id: string }>;
    for (const row of rows) {
      const key = `${row.datum}|${row.teller}`;
      if (!current.has(key)) current.set(key, row);
    }
  }

  const existing = db
    .prepare('SELECT id, datum, teller, person_id, bron, bron_period_id FROM dienstrooster_prior_assignment WHERE period_id = ?')
    .all(periodId) as Array<{ id: string; datum: string; teller: string; person_id: string | null; bron: string; bron_period_id: string | null }>;
  const byKey = new Map(existing.map((r) => [`${r.datum}|${r.teller}`, r]));

  let added = 0;
  let changed = 0;
  let removed = 0;
  db.transaction(() => {
    const update = db.prepare('UPDATE dienstrooster_prior_assignment SET person_id = ?, bron_period_id = ? WHERE id = ?');
    const remove = db.prepare('DELETE FROM dienstrooster_prior_assignment WHERE id = ?');
    const insert = db.prepare(
      `INSERT INTO dienstrooster_prior_assignment
         (id, period_id, datum, iso_jaar, iso_week, teller, person_id, bron, bron_period_id, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'AFGELEID', ?, ?, ?)`
    );

    for (const row of existing) {
      if (row.bron !== 'AFGELEID') continue;
      const live = current.get(`${row.datum}|${row.teller}`);
      if (!live) {
        remove.run(row.id);
        removed++;
      } else if (live.person_id !== row.person_id || row.bron_period_id !== previous!.id) {
        update.run(live.person_id, previous!.id, row.id);
        changed++;
      }
    }
    for (const [key, row] of current) {
      if (byKey.has(key)) continue;
      insert.run(crypto.randomUUID(), periodId, row.datum, row.iso_jaar, row.iso_week, row.teller, row.person_id, previous!.id, actorId, now);
      added++;
    }
  })();

  return { previous, range, added, changed, removed };
}
