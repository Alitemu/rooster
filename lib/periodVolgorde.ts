/**
 * Periods of a pool follow each other: the saldo that carries over from one
 * period to the next is worked out from the period before, and it counts the
 * period only once it is published (lib/previousPeriod.ts). Generating or
 * publishing a period while the one before it is not published yet therefore
 * carries over from the period before THAT one: the difference of the skipped
 * period is booked twice or not at all, and a published roster is never
 * corrected afterwards (0.805.0).
 *
 * The period before is the latest one of the pool that ends before this one
 * starts and is not in the prullenbak, whatever its status.
 */

import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { periodStatusLabel } from '@/lib/statusLabels';

export interface VorigePeriode {
  id: string;
  naam: string;
  status: string;
}

/** The period before this one when it is not published yet, otherwise null (also when there is none). */
export function onuitgegevenVorigePeriode(periodId: string): VorigePeriode | null {
  const huidig = db
    .prepare('SELECT pool_id, start_datum FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as { pool_id: string; start_datum: string } | undefined;
  if (!huidig) return null;
  const vorige = db
    .prepare(
      `SELECT id, naam, status FROM dienstrooster_schedule_period
       WHERE pool_id = ? AND eind_datum < ? AND verwijderd_op IS NULL AND id <> ?
       ORDER BY eind_datum DESC, start_datum DESC LIMIT 1`
    )
    .get(huidig.pool_id, huidig.start_datum, periodId) as VorigePeriode | undefined;
  return vorige && vorige.status !== 'GEPUBLICEERD' ? vorige : null;
}

export const VORIGE_PERIODE_CODE = 'VORIGE_PERIODE_NIET_GEPUBLICEERD';

/** The 409 for generating or publishing before the period before is published, or null. */
export function vorigePeriodeDenial(periodId: string): NextResponse | null {
  const vorige = onuitgegevenVorigePeriode(periodId);
  if (!vorige) return null;
  return NextResponse.json(
    {
      success: false,
      error: `Publiceer eerst de vorige periode "${vorige.naam}" (nu ${periodStatusLabel(vorige.status)}), of zet die in de prullenbak. Anders klopt het saldo van deze periode niet.`,
      code: VORIGE_PERIODE_CODE,
    },
    { status: 409 }
  );
}
