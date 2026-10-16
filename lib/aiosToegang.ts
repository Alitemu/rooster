/**
 * Who may use an AIOS period on the AIOS's own routes (app/api/aios).
 *
 * The achterwacht's participant routes ask periodUsableFor
 * (lib/periodAccess.ts), which refuses an AIOS period; the AIOS's routes
 * ask this instead, and only ever load an AIOS period (loadAiosPeriode).
 * Built on the shared checks (staffMayAccessPeriod, isPeriodVisibleToPerson),
 * used as they are.
 */

import { requirePlannerAccess, type AuthContext } from '@/lib/auth-context';
import { staffMayAccessPeriod } from '@/lib/dienstAccess';
import { isPeriodVisibleToPerson, type PeriodScope } from '@/lib/periodAccess';

/** A participant: their own AIOS period. A planner: an AIOS period of a dienst they see. */
export function aiosPeriodeBruikbaarVoor(auth: AuthContext, personId: string, period: PeriodScope): boolean {
  if (requirePlannerAccess(auth)) return staffMayAccessPeriod(auth, period.id);
  return isPeriodVisibleToPerson(personId, period);
}
