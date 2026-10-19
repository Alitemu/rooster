/**
 * The fte of each AIOS as it was when the quarter's roster was made, held
 * with the roster (dienstrooster_period_factor, the table the achterwacht's
 * deelnamefactor also uses: lib/deelnamefactor.ts, a copy and not shared).
 *
 * The fte follows from the part-time days an AIOS gives, and those change
 * from one quarter to the next: 1,0 in one, 0,8 in the next. The
 * dienstpercentage of a made roster, and over the last four quarters, counts
 * each quarter with the fte of that quarter. Only while there is a roster
 * (gegenereerd or gepubliceerd): before it, and after it is removed, the fte
 * follows the part-time days as they are.
 */

import crypto from 'crypto';
import { db } from '@/db/client';

export function bevrorenAiosFte(periodId: string): Map<string, number> {
  const rijen = db
    .prepare(
      `SELECT f.person_id, f.factor FROM dienstrooster_period_factor f
       JOIN dienstrooster_schedule_period p ON p.id = f.period_id
       WHERE f.period_id = ? AND p.status IN ('GEGENEREERD', 'GEPUBLICEERD')`
    )
    .all(periodId) as Array<{ person_id: string; factor: number }>;
  return new Map(rijen.map((r) => [r.person_id, r.factor]));
}

/** Holds the fte the roster was made with, replacing an earlier roster's. Inside the transaction that writes the roster. */
export function legAiosFteVast(periodId: string, aios: ReadonlyArray<{ id: string; fte: number }>): void {
  db.prepare('DELETE FROM dienstrooster_period_factor WHERE period_id = ?').run(periodId);
  const voeg = db.prepare('INSERT INTO dienstrooster_period_factor (id, period_id, person_id, factor) VALUES (?, ?, ?, ?)');
  for (const a of aios) voeg.run(crypto.randomUUID(), periodId, a.id, a.fte);
}

export function wisAiosFteVast(periodId: string): void {
  db.prepare('DELETE FROM dienstrooster_period_factor WHERE period_id = ?').run(periodId);
}
