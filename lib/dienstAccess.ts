/**
 * Which dienst a staff account may see.
 *
 * The achterwacht and the AIOS are two rosters with two planners, and
 * neither may see the other's pools, periods, rosters or preferences (the
 * planner's words: "Ze mogen elkaars rooster en voorkeuren niet inzien").
 * A pool's `type` is its dienst, a planner's `dienst_type` theirs
 * (lib/staffAccounts.ts); a beheerder sees every dienst.
 *
 * The pools share nobody: a participant belongs to the dienst of the pools
 * they are a member of, and adding someone of the other dienst is refused
 * (the members route).
 *
 * Something of the other dienst answers 404, like an id that does not
 * exist: a planner learns nothing about what the other one has. An id that
 * is no pool, period or person passes here, so the route answers its own
 * 404 as before.
 */

import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import type { AuthContext } from '@/lib/auth-context';
import type { DienstType } from '@/lib/staffAccounts';

function isStaff(auth: AuthContext | null): auth is AuthContext {
  return auth !== null && (auth.role === 'ADMIN' || auth.role === 'PLANNER');
}

/**
 * The one dienst a staff account sees, or null for every dienst (a
 * beheerder). For the lists: pools, periods, the prullenbak.
 */
export function visibleDienst(auth: AuthContext): DienstType | null {
  return auth.role === 'ADMIN' ? null : (auth.dienst ?? 'ACHTERWACHT');
}

export function staffMayAccessPool(auth: AuthContext, poolId: string): boolean {
  const dienst = visibleDienst(auth);
  if (dienst === null) return true;
  const pool = db.prepare('SELECT type FROM dienstrooster_pool WHERE id = ?').get(poolId) as
    | { type: string }
    | undefined;
  return !pool || pool.type === dienst;
}

export function staffMayAccessPeriod(auth: AuthContext, periodId: string): boolean {
  const dienst = visibleDienst(auth);
  if (dienst === null) return true;
  const row = db
    .prepare(
      `SELECT pl.type FROM dienstrooster_schedule_period sp
       JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
       WHERE sp.id = ?`
    )
    .get(periodId) as { type: string } | undefined;
  return !row || row.type === dienst;
}

/** A participant of the other dienst: a member of one of its pools, at any time. */
export function staffMayAccessPerson(auth: AuthContext, personId: string): boolean {
  const dienst = visibleDienst(auth);
  if (dienst === null) return true;
  const other = db
    .prepare(
      `SELECT 1 FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_pool pl ON pl.id = pm.pool_id
       WHERE pm.person_id = ? AND pl.type <> ? LIMIT 1`
    )
    .get(personId, dienst);
  return !other;
}

/**
 * Whether someone has anything of another dienst than this one: a
 * membership of one of its pools, or a link, a mark, a dienst or a hand-in
 * in one of its periods. With every membership removed, the rest still says
 * whose they were: the members route keeps them out of this dienst's pools.
 */
export function personHasOtherDienst(personId: string, dienst: string): boolean {
  const inPeriod = (from: string, period: string) =>
    `EXISTS (SELECT 1 FROM ${from}
             JOIN dienstrooster_schedule_period sp ON sp.id = ${period}
             JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
             WHERE x.person_id = @person AND pl.type <> @dienst)`;
  const row = db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM dienstrooster_pool_membership x JOIN dienstrooster_pool pl ON pl.id = x.pool_id
                      WHERE x.person_id = @person AND pl.type <> @dienst)
         OR ${inPeriod('dienstrooster_person_access_link x', 'x.geldt_voor_periode_id')}
         OR ${inPeriod('dienstrooster_availability x JOIN dienstrooster_shift_slot s ON s.id = x.slot_id', 's.period_id')}
         OR ${inPeriod('dienstrooster_assignment x', 'x.schedule_version_id')}
         OR ${inPeriod('dienstrooster_submission x', 'x.schedule_period_id')} AS ja`
    )
    .get({ person: personId, dienst }) as { ja: number };
  return row.ja === 1;
}

export function notThisDienstResponse(): NextResponse {
  return NextResponse.json({ success: false, error: { code: 'NOT_FOUND', message: 'Niet gevonden' } }, { status: 404 });
}

/**
 * The 404 for a staff account asking about a period of another dienst, or
 * null. Not for participants: their own checks (lib/periodAccess.ts) say
 * which periods are theirs. Called right after the route's own staff check.
 */
export function periodDienstDenial(auth: AuthContext | null, periodId: string): NextResponse | null {
  if (!isStaff(auth)) return null;
  return staffMayAccessPeriod(auth, periodId) ? null : notThisDienstResponse();
}

export function poolDienstDenial(auth: AuthContext | null, poolId: string): NextResponse | null {
  if (!isStaff(auth)) return null;
  return staffMayAccessPool(auth, poolId) ? null : notThisDienstResponse();
}

export function personDienstDenial(auth: AuthContext | null, personId: string): NextResponse | null {
  if (!isStaff(auth)) return null;
  return staffMayAccessPerson(auth, personId) ? null : notThisDienstResponse();
}
