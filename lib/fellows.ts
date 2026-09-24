/**
 * Fellows: they support the AIOS on the voorwacht on Saturdays, so they
 * are not available for weekend shifts.
 *
 * Ticking "Ik ben fellow" for a period (the participant on their
 * preferences page, or the planner) blocks every Saturday and Sunday of
 * that period, feestdagen on a weekend included; weekday feestdagen stay
 * open. The blocks are ordinary ABSOLUUT availability rows, so the solver,
 * the manual-assign warnings and the publication check all treat them like
 * any other block. They carry `fellow_blok` so unticking removes exactly
 * those and nothing the person marked themselves.
 *
 * A fellow may still release a weekend day (clear it, or mark it voorkeur
 * or liever niet): that makes the row their own (the slot route clears
 * `fellow_blok`), and every weekend day they leave unblocked raises how
 * many weekend shifts they can get (lib/rosterBands.ts, fellowWeekendBand).
 *
 * Fellows don't count for the weekend band of the others, so theirs goes
 * up automatically at generation (resolvePeriodBands).
 *
 * Per period only: nothing carries over to the next one.
 */

import { db } from '@/db/client';
import { syncPatternsForPerson } from './parttimeSync';
import { syncAbsencesForPerson } from './absenceSync';

export const FELLOW_UITLEG =
  'Je weekenden worden geblokkeerd, omdat je op een zaterdag al ingedeeld kan worden ' +
  'om de AIOS te ondersteunen bij de voorwacht.';

/** Saturday or Sunday, from an ISO date column. */
const WEEKEND_DAY_SQL = `strftime('%w', s.datum) IN ('0', '6')`;

export function isFellow(periodId: string, personId: string): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 FROM dienstrooster_period_fellow WHERE period_id = ? AND person_id = ?')
      .get(periodId, personId)
  );
}

export function getFellowIds(periodId: string): Set<string> {
  return new Set(
    (
      db.prepare('SELECT person_id FROM dienstrooster_period_fellow WHERE period_id = ?').all(periodId) as Array<{
        person_id: string;
      }>
    ).map((r) => r.person_id)
  );
}

/**
 * Per fellow: how many of the period's weekenddiensten they left
 * unblocked. That is the most weekend shifts they can get.
 */
export function releasedWeekendDays(periodId: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT pf.person_id,
         (SELECT COUNT(*) FROM dienstrooster_shift_slot s
            JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
           WHERE s.period_id = pf.period_id AND st.teller = 'WEEKEND'
             AND NOT EXISTS (
               SELECT 1 FROM dienstrooster_availability a
                WHERE a.person_id = pf.person_id AND a.slot_id = s.id AND a.blocking_level = 'ABSOLUUT'
             )) AS vrij
       FROM dienstrooster_period_fellow pf
       WHERE pf.period_id = ?`
    )
    .all(periodId) as Array<{ person_id: string; vrij: number }>;
  return new Map(rows.map((r) => [r.person_id, r.vrij]));
}

/**
 * Tick or untick "fellow" for one person in one period. Returns whether
 * anything changed.
 *
 * Ticking blocks every weekend day the person has not marked themselves.
 * Unticking removes only those blocks; a part-time pattern or registered
 * absence that was skipped for a fellow block then gets its day back.
 */
export function setFellow(periodId: string, personId: string, aan: boolean): boolean {
  const now = new Date().toISOString();
  const changed = db.transaction(() => {
    if (aan) {
      const added = db
        .prepare(
          `INSERT OR IGNORE INTO dienstrooster_period_fellow (id, period_id, person_id, aangemaakt_op)
           VALUES (?, ?, ?, ?)`
        )
        .run(crypto.randomUUID(), periodId, personId, now);
      if (added.changes === 0) return false;
      const weekendSlots = db
        .prepare(
          `SELECT s.id FROM dienstrooster_shift_slot s
           WHERE s.period_id = ? AND ${WEEKEND_DAY_SQL}
             AND NOT EXISTS (
               SELECT 1 FROM dienstrooster_availability a WHERE a.person_id = ? AND a.slot_id = s.id
             )`
        )
        .all(periodId, personId) as Array<{ id: string }>;
      const insert = db.prepare(
        `INSERT INTO dienstrooster_availability
           (id, person_id, slot_id, blocking_level, source, fellow_blok, aangemaakt_op)
         VALUES (?, ?, ?, 'ABSOLUUT', 'MANUAL', 1, ?)`
      );
      for (const slot of weekendSlots) insert.run(crypto.randomUUID(), personId, slot.id, now);
      return true;
    }

    const removed = db
      .prepare('DELETE FROM dienstrooster_period_fellow WHERE period_id = ? AND person_id = ?')
      .run(periodId, personId);
    if (removed.changes === 0) return false;
    db.prepare(
      `DELETE FROM dienstrooster_availability
       WHERE person_id = ? AND fellow_blok = 1
         AND slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)`
    ).run(personId, periodId);
    return true;
  })();

  if (changed && !aan) {
    syncPatternsForPerson(personId);
    syncAbsencesForPerson(personId);
  }
  return changed;
}
