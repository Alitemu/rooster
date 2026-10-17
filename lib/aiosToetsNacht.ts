/**
 * The date of an AIOS quarter's voortgangstoets and the fellow's night
 * before it, read only (lib/aiosVoortgangstoets.ts saves it). A module of
 * its own, with nothing but the database: lib/aiosSlots.ts reads it, and
 * the browser tests load that file outside Next.js, where the saving side's
 * imports (next/server, by way of lib/requestFields.ts) do not resolve.
 */

import { db } from '@/db/client';
import { addDays } from '@/lib/holidays';

export interface AiosVoortgangstoets {
  datum: string | null;
  // The night the fellow does: the day before.
  nacht: string | null;
}

export function aiosVoortgangstoets(periodId: string): AiosVoortgangstoets {
  const rij = db.prepare('SELECT voortgangstoets FROM dienstrooster_aios_periode WHERE period_id = ?').get(periodId) as
    | { voortgangstoets: string | null }
    | undefined;
  const datum = rij?.voortgangstoets ?? null;
  return { datum, nacht: datum ? addDays(datum, -1) : null };
}

/** The date of the fellow's night, for the screens that show "Fellow" there. */
export function fellowNacht(periodId: string): string | null {
  return aiosVoortgangstoets(periodId).nacht;
}
