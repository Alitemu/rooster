/**
 * The fellow's weekend blocks (lib/fellows.ts) as rows, in a module of its
 * own so lib/parttimeSync.ts and lib/absenceSync.ts can use it: lib/fellows.ts
 * imports both of them.
 */

import { db } from '@/db/client';

/** Saturday or Sunday, from an ISO date column on a slot aliased `s`. */
export const WEEKEND_DAY_SQL = `strftime('%w', s.datum) IN ('0', '6')`;

/**
 * A part-time pattern or an absence just let go of these days. For a
 * fellow, a weekend day among them goes back to being a fellow block
 * instead of turning open: the fellow never released it themselves, it
 * was only blocked for another reason first (ticking "fellow" skips a day
 * that already has a row, and an absence takes a fellow block over).
 * Open, it would count as a released day and raise the most weekend
 * shifts they can get (lib/fellows.ts releasedWeekendDays).
 *
 * Call after the rows were deleted, in the same transaction if there is one.
 */
export function restoreFellowBlocks(personId: string, slotIds: string[]): number {
  if (slotIds.length === 0) return 0;
  const candidate = db.prepare(
    `SELECT 1 FROM dienstrooster_shift_slot s
     JOIN dienstrooster_period_fellow pf ON pf.period_id = s.period_id AND pf.person_id = ?
     WHERE s.id = ? AND ${WEEKEND_DAY_SQL}
       AND NOT EXISTS (SELECT 1 FROM dienstrooster_availability a WHERE a.person_id = ? AND a.slot_id = s.id)`
  );
  const insert = db.prepare(
    `INSERT INTO dienstrooster_availability
       (id, person_id, slot_id, blocking_level, source, fellow_blok, aangemaakt_op)
     VALUES (?, ?, ?, 'ABSOLUUT', 'MANUAL', 1, ?)`
  );
  const now = new Date().toISOString();
  let restored = 0;
  for (const slotId of slotIds) {
    if (!candidate.get(personId, slotId, personId)) continue;
    insert.run(crypto.randomUUID(), personId, slotId, now);
    restored++;
  }
  return restored;
}
