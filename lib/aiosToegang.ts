/**
 * Who may use an AIOS period on the AIOS's own routes (app/api/aios).
 *
 * The achterwacht's participant routes ask periodUsableFor
 * (lib/periodAccess.ts), which refuses an AIOS period; the AIOS's routes
 * ask this instead, and only ever load an AIOS period (loadAiosPeriode).
 * A planner through the shared dienst check (staffMayAccessPeriod), a
 * participant through a copy of lib/periodAccess.ts isPeriodVisibleToPerson
 * (docs/development/diensten.md, "Copied, not changed").
 */

import type { NextResponse } from 'next/server';
import { requirePlannerAccess, type AuthContext } from '@/lib/auth-context';
import { isAiosPerson } from '@/lib/aiosPeriod';
import { notThisDienstResponse, staffMayAccessPeriod } from '@/lib/dienstAccess';
import { db } from '@/db/client';

export interface PeriodScope {
  id: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
}

/**
 * Whether the period is theirs: not in the prullenbak, and a link issued
 * for it (which keeps working after they left the pool, to read the roster
 * they are in) or a membership of its pool for dates that overlap it
 * (someone added while the quarter is open, before any link).
 */
function periodeVanPersoon(personId: string, period: PeriodScope): boolean {
  if (db.prepare('SELECT 1 FROM dienstrooster_schedule_period WHERE id = ? AND verwijderd_op IS NOT NULL').get(period.id)) return false;
  const viaLink = db
    .prepare(
      `SELECT 1 FROM dienstrooster_person_access_link
       WHERE person_id = ? AND geldt_voor_periode_id = ? AND ingetrokken_op IS NULL LIMIT 1`
    )
    .get(personId, period.id);
  if (viaLink) return true;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM dienstrooster_pool_membership
         WHERE person_id = ? AND pool_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ? LIMIT 1`
      )
      .get(personId, period.pool_id, period.eind_datum, period.start_datum)
  );
}

/** A participant: their own AIOS period. A planner: an AIOS period of a dienst they see. */
/**
 * The 404 for an AIOS route asked about someone who is not an AIOS, or
 * null, whoever asks: the achterwacht's participants keep to their own
 * routes and sync (docs/development/diensten.md).
 */
export function geenAiosDenial(personId: string): NextResponse | null {
  return isAiosPerson(personId) ? null : notThisDienstResponse();
}

export function aiosPeriodeBruikbaarVoor(auth: AuthContext, personId: string, period: PeriodScope): boolean {
  if (requirePlannerAccess(auth)) return staffMayAccessPeriod(auth, period.id);
  return periodeVanPersoon(personId, period);
}
