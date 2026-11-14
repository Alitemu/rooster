/**
 * A change to a membership that reaches a period whose roster already
 * exists (GEGENEREERD or GEPUBLICEERD) needs the planner's say-so: the
 * roster does not change with it, so the person stays in a roster they are
 * no longer part of, or the other way round, and the saldo and the bereik
 * of everyone else were worked out with the old membership.
 */

import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { periodStatusLabel } from '@/lib/statusLabels';

export const LIDMAATSCHAP_RAAKT_ROOSTER = 'LIDMAATSCHAP_RAAKT_ROOSTER';

interface Bereik {
  geldig_vanaf: string;
  geldig_tot: string;
}

function dagVoor(datum: string): string {
  return new Date(Date.parse(`${datum}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
function dagNa(datum: string): string {
  return new Date(Date.parse(`${datum}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

/**
 * The days on which the membership differs between `oud` and `nieuw`
 * (`nieuw` null: it is removed). Two stretches at most: the start moved
 * and the end moved.
 */
export function veranderdeDagen(oud: Bereik, nieuw: Bereik | null): Array<[string, string]> {
  if (!nieuw) return [[oud.geldig_vanaf, oud.geldig_tot]];
  const stukken: Array<[string, string]> = [];
  if (oud.geldig_vanaf !== nieuw.geldig_vanaf) {
    const [vroeg, laat] = [oud.geldig_vanaf, nieuw.geldig_vanaf].sort();
    stukken.push([vroeg, dagVoor(laat)]);
  }
  if (oud.geldig_tot !== nieuw.geldig_tot) {
    const [vroeg, laat] = [oud.geldig_tot, nieuw.geldig_tot].sort();
    stukken.push([dagNa(vroeg), laat]);
  }
  return stukken;
}

export interface GetroffenPeriode {
  id: string;
  naam: string;
  status: string;
}

/** Periods of the pool with a roster that overlap a day on which the membership changes. */
export function getroffenRoosters(poolId: string, oud: Bereik, nieuw: Bereik | null): GetroffenPeriode[] {
  const gevonden = new Map<string, GetroffenPeriode>();
  const zoek = db.prepare(
    `SELECT id, naam, status FROM dienstrooster_schedule_period
     WHERE pool_id = ? AND verwijderd_op IS NULL AND status IN ('GEGENEREERD', 'GEPUBLICEERD')
       AND start_datum <= ? AND eind_datum >= ?
     ORDER BY start_datum`
  );
  for (const [van, tot] of veranderdeDagen(oud, nieuw)) {
    if (van > tot) continue;
    for (const p of zoek.all(poolId, tot, van) as GetroffenPeriode[]) gevonden.set(p.id, p);
  }
  return [...gevonden.values()];
}

/** 409 asking for confirmation when a roster is reached; null when the change may go ahead. */
export function lidmaatschapRoosterDenial(
  poolId: string,
  oud: Bereik,
  nieuw: Bereik | null,
  bevestigd: boolean
): NextResponse | null {
  if (bevestigd) return null;
  const getroffen = getroffenRoosters(poolId, oud, nieuw);
  if (getroffen.length === 0) return null;
  const lijst = getroffen.map((p) => `"${p.naam}" (${periodStatusLabel(p.status).toLowerCase()})`).join(', ');
  return NextResponse.json(
    {
      success: false,
      error: {
        code: LIDMAATSCHAP_RAAKT_ROOSTER,
        message:
          `Dit raakt een periode met een rooster: ${lijst}. Het rooster verandert niet mee. ` +
          `Daardoor kan iemand in een rooster blijven staan of ontbreken terwijl het lidmaatschap anders zegt. ` +
          `Bevestig om toch door te gaan.`,
      },
    },
    { status: 409 }
  );
}
