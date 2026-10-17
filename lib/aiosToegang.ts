/**
 * Who may use an AIOS period on the AIOS's own routes (app/api/aios).
 *
 * The achterwacht's participant routes ask periodUsableFor
 * (lib/periodAccess.ts), which refuses an AIOS period; the AIOS's routes
 * ask this instead, and only ever load an AIOS period (loadAiosPeriode).
 * Built on the shared checks (staffMayAccessPeriod, isPeriodVisibleToPerson),
 * used as they are.
 */

import type { NextResponse } from 'next/server';
import { requirePlannerAccess, type AuthContext } from '@/lib/auth-context';
import { isAiosPerson } from '@/lib/aiosPeriod';
import { notThisDienstResponse, staffMayAccessPeriod } from '@/lib/dienstAccess';
import { isPeriodVisibleToPerson, type PeriodScope } from '@/lib/periodAccess';

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
  return isPeriodVisibleToPerson(personId, period);
}
