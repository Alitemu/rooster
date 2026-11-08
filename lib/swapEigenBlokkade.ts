/**
 * A swap never hands the requester a day they blocked themselves (audit 1.2.2).
 *
 * The achterwacht's swap dialog used to warn only about the colleague's stance towards the offered
 * day. A requester could ask for, and get, a shift on a day they had marked geblokkeerd (by hand, a
 * deeltijddag, an absence or a fellow weekend): the roster then showed it red in "Jouw rooster", a
 * vacation entered only as a geblokkeerde dag among them. The AIOS's swaps never offer such a swap
 * (lib/aiosRuilen.ts keeps only swaps within the rules for both). Here the candidate list leaves it
 * out (lib/swapCandidates.ts) and the create route refuses it.
 *
 * The colleague's own block on the offered day stays allowed: that is their call when they approve,
 * and the dialog tells the requester the chance of a yes is smaller.
 */
import { db } from '@/db/client';

export const EIGEN_BLOKKADE_MELDING =
  'Je hebt de dag van die dienst zelf geblokkeerd, of je bent dan afwezig of hebt een deeltijddag. Deze ruil kan niet. Wil je die dag toch werken? Overleg dan met de planner.';

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
