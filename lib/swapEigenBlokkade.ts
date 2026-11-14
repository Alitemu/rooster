/**
 * A swap onto a day the requester blocked themselves: allowed, with a warning (audit 1.2.2, the
 * planner's choice in 1.3.0: "hier moet er gewaarschuwd worden en geen blokkade").
 *
 * The achterwacht's swap dialog used to warn only about the colleague's stance towards the offered
 * day. A requester could ask for, and get, a shift on a day they had marked geblokkeerd (by hand, a
 * deeltijddag, an absence or a fellow weekend) without a word: the roster then showed it red in
 * "Jouw rooster", a vacation entered only as a geblokkeerde dag among them. Someone may still want
 * to work that day after all, so the swap is not refused: the candidate list marks the shift
 * (lib/swapCandidates.ts, requester_geblokkeerd) and the dialog says so before the request goes out
 * (lib/eigenBlokkadeWaarschuwing.ts).
 */
import { db } from '@/db/client';

/** The requester marked the slot ABSOLUUT, whatever the source. */
export function eigenBlokkadeOp(personId: string, slotId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ? AND blocking_level = 'ABSOLUUT'`
      )
      .get(personId, slotId)
  );
}
