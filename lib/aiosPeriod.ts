/**
 * Telling an AIOS period from an achterwacht one.
 *
 * The AIOS roster is built in steps (docs/aios-rooster.md, "Bouwvolgorde").
 * Until the AIOS preferences screen, solver and publishing exist, an AIOS
 * period can be made and looked at (its diensten, blocks and points) but
 * not opened: opening and the steps after it are the achterwacht's, which
 * would invite the AIOS to a calendar of avond-, weekend- and
 * feestdagdiensten and roster them by the achterwacht's rules.
 */

import { NextResponse } from 'next/server';
import { db } from '@/db/client';

export function isAiosPool(poolId: string): boolean {
  const row = db.prepare('SELECT type FROM dienstrooster_pool WHERE id = ?').get(poolId) as { type: string } | undefined;
  return row?.type === 'AIOS';
}

export function isAiosPeriod(periodId: string): boolean {
  const row = db
    .prepare(
      `SELECT pl.type FROM dienstrooster_schedule_period sp
       JOIN dienstrooster_pool pl ON pl.id = sp.pool_id WHERE sp.id = ?`
    )
    .get(periodId) as { type: string } | undefined;
  return row?.type === 'AIOS';
}

export const AIOS_NOG_NIET =
  'Een periode van de AIOS kan nog niet geopend worden. Het voorkeurenscherm, het maken van het rooster en het publiceren voor de AIOS komen in een volgende versie.';

/** The 409 for an achterwacht step asked of an AIOS period, or null. */
export function aiosNotYetDenial(periodId: string): NextResponse | null {
  if (!isAiosPeriod(periodId)) return null;
  return NextResponse.json({ success: false, error: { code: 'AIOS_NOG_NIET', message: AIOS_NOG_NIET } }, { status: 409 });
}
