/**
 * Which periods a participant is allowed to see.
 *
 * Staff reach every period by role; a participant does not, and several
 * routes used to take "you are authenticated" as enough. With one pool
 * that difference is invisible, but the datamodel has always allowed more
 * than one (pool_membership carries dates per pool), and a check that only
 * happens to be right because of the current data is not a check.
 */

import { db } from '@/db/client';
import { requirePlannerAccess, type AuthContext } from '@/lib/auth-context';
import { staffMayAccessPeriod } from '@/lib/dienstAccess';
import { isAiosPeriod } from '@/lib/aiosPeriod';

export interface PeriodScope {
  id: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
}

/**
 * True when this participant belongs to the period: either they hold an
 * access link issued for it, or they are a member of its pool for dates
 * that overlap it.
 *
 * Both count, and neither alone is enough. The link is what an invitation
 * mail gives them, and it keeps working for a period they have since left
 * the pool for - they still need to read the roster they are in. Pool
 * membership covers the other direction: someone added to the pool while a
 * period is already open, before any link has been exported for them.
 */
export function isPeriodVisibleToPerson(personId: string, period: PeriodScope): boolean {
  // A period in the trash is on its way to being purged: verify-link
  // already stops resolving it, and a session opened before it was
  // trashed must not keep reading it or writing preferences into it.
  const trashed = db
    .prepare('SELECT 1 FROM dienstrooster_schedule_period WHERE id = ? AND verwijderd_op IS NOT NULL')
    .get(period.id);
  if (trashed) return false;

  const viaLink = db
    .prepare(
      `SELECT 1 FROM dienstrooster_person_access_link
       WHERE person_id = ? AND geldt_voor_periode_id = ? AND ingetrokken_op IS NULL
       LIMIT 1`
    )
    .get(personId, period.id);
  if (viaLink) return true;

  const viaMembership = db
    .prepare(
      `SELECT 1 FROM dienstrooster_pool_membership
       WHERE person_id = ? AND pool_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?
       LIMIT 1`
    )
    .get(personId, period.pool_id, period.eind_datum, period.start_datum);
  return Boolean(viaMembership);
}

/**
 * A swap request, read the way the participant's swap routes act on one:
 * not at all once its period is in the prullenbak. Approving still moved
 * the shifts of a roster nobody could see any more, and rejecting or
 * withdrawing mailed colleagues about it (audit 13). It comes back with
 * the period. Nor one of an AIOS period: swapping there (a block or one
 * dienst of it) comes with the AIOS roster's own step (lib/aiosPeriod.ts).
 */
export const LIVE_SWAP_REQUEST_SQL = `SELECT sr.* FROM dienstrooster_swap_request sr
  JOIN dienstrooster_schedule_period p ON p.id = sr.periode_id
  JOIN dienstrooster_pool pl ON pl.id = p.pool_id
  WHERE sr.id = ? AND p.verwijderd_op IS NULL AND pl.type <> 'AIOS'`;

/**
 * Whether this request may use the period on the person's behalf: a
 * participant only a period that is theirs (isPeriodVisibleToPerson), a
 * planner one of their own dienst (lib/dienstAccess.ts), a beheerder any.
 * Planners used to pass on their role alone: with someone of their own
 * dienst and a period id of the other one, the fellow and slot routes wrote
 * into the other dienst's roster.
 */
/**
 * The same for the AIOS's own participant routes, which load the period
 * with loadAiosPeriode (lib/aiosPreferences.ts): an AIOS period only. The
 * achterwacht's routes ask periodUsableFor, which refuses an AIOS period.
 */
export function aiosPeriodUsableFor(auth: AuthContext, personId: string, period: PeriodScope): boolean {
  if (requirePlannerAccess(auth)) return staffMayAccessPeriod(auth, period.id);
  return isPeriodVisibleToPerson(personId, period);
}

export function periodUsableFor(auth: AuthContext, personId: string, period: PeriodScope): boolean {
  // The participant's screens are the achterwacht's: an AIOS period gets
  // its own in a later step, and until then nobody uses it through these,
  // the beheerder acting for an AIOS participant included (lib/aiosPeriod.ts).
  if (isAiosPeriod(period.id)) return false;
  if (requirePlannerAccess(auth)) return staffMayAccessPeriod(auth, period.id);
  return isPeriodVisibleToPerson(personId, period);
}
