/**
 * Telling an AIOS period from an achterwacht one.
 *
 * The AIOS roster is built in steps (docs/aios-rooster.md, "Bouwvolgorde").
 * Until the AIOS preferences screen, solver and publishing exist, an AIOS
 * period can be made and looked at (its diensten, blocks and points),
 * renamed, put in the prullenbak and back, but nothing else: opening and
 * every step after it are the achterwacht's, which would invite the AIOS
 * to a calendar of avond-, weekend- and feestdagdiensten and roster them
 * by the achterwacht's rules. Every planner route that changes a period
 * asks aiosNotYetDenial, the participant routes periodUsableFor
 * (lib/periodAccess.ts); app/api/aiosNotYet.test.ts sweeps them.
 */

import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { notThisDienstResponse } from '@/lib/dienstAccess';

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
  'Dit kan nog niet bij een periode van de AIOS. Het voorkeurenscherm, het maken van het rooster en het publiceren voor de AIOS komen in een volgende versie.';

/** Someone of the AIOS: a member of an AIOS pool, at any time (a person belongs to one dienst). */
export function isAiosPerson(personId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM dienstrooster_pool_membership pm JOIN dienstrooster_pool pl ON pl.id = pm.pool_id
         WHERE pm.person_id = ? AND pl.type = 'AIOS' LIMIT 1`
      )
      .get(personId)
  );
}

/**
 * The 404 for an achterwacht participant route asked about an AIOS, or
 * null, whoever asks: an AIOS's absences, part-time days and the rest go
 * through the AIOS's own routes (app/api/aios/deelnemer) and sync. Here they
 * got the achterwacht's sync only (docs/development/diensten.md).
 */
export function aiosPersonDenial(personId: string): NextResponse | null {
  return isAiosPerson(personId) ? notThisDienstResponse() : null;
}

/** The 409 for an achterwacht step asked of an AIOS period, or null. */
export function aiosNotYetDenial(periodId: string): NextResponse | null {
  if (!isAiosPeriod(periodId)) return null;
  return NextResponse.json({ success: false, error: { code: 'AIOS_NOG_NIET', message: AIOS_NOG_NIET } }, { status: 409 });
}
