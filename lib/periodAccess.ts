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
