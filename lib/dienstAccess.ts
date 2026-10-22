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

/**
 * For what belongs to one dienst only (the achterwacht's mail settings and
 * their status): the other dienst's planner gets the same 404 as for any
 * other thing of the other dienst. A beheerder sees both.
 */
export function eigenDienstDenial(auth: AuthContext, dienst: DienstType): NextResponse | null {
  const zichtbaar = visibleDienst(auth);
  return zichtbaar === null || zichtbaar === dienst ? null : notThisDienstResponse();
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

/**
 * Where a person can leave something in a dienst: a table that holds them,
 * and the pool or the period (through its pool) it hangs on. A membership
 * is the usual sign, but the rest stays after the last membership is
 * removed (a link, a mark, a dienst, a hand-in, a swap, a balance, an AIOS
 * wish ...), and that is what keeps them in their dienst.
 */
const PERSON_IN_POOL: Array<{ from: string; person: string; pool: string }> = [
  { from: 'dienstrooster_pool_membership', person: 'person_id', pool: 'pool_id' },
  { from: 'dienstrooster_ledger_entry', person: 'person_id', pool: 'pool_id' },
  { from: 'dienstrooster_aios_beginstand', person: 'person_id', pool: 'pool_id' },
];
const PERSON_IN_PERIOD: Array<{ from: string; person: string; period: string }> = [
  { from: 'dienstrooster_person_access_link', person: 'person_id', period: 'geldt_voor_periode_id' },
  { from: 'dienstrooster_availability JOIN dienstrooster_shift_slot s ON s.id = x.slot_id', person: 'person_id', period: 's.period_id' },
  { from: 'dienstrooster_assignment', person: 'person_id', period: 'schedule_version_id' },
  { from: 'dienstrooster_submission', person: 'person_id', period: 'schedule_period_id' },
  { from: 'dienstrooster_swap_request', person: 'aanvrager_person_id', period: 'periode_id' },
  { from: 'dienstrooster_swap_request', person: 'respondent_person_id', period: 'periode_id' },
  { from: 'dienstrooster_notification', person: 'person_id', period: 'periode_id' },
  { from: 'dienstrooster_period_fellow', person: 'person_id', period: 'period_id' },
  { from: 'dienstrooster_prior_assignment', person: 'person_id', period: 'period_id' },
  { from: 'dienstrooster_aios_wens', person: 'person_id', period: 'period_id' },
  { from: 'dienstrooster_aios_reden', person: 'person_id', period: 'period_id' },
  { from: 'dienstrooster_aios_doel', person: 'person_id', period: 'period_id' },
  { from: 'dienstrooster_aios_ruil', person: 'aanvrager_id', period: 'period_id' },
  { from: 'dienstrooster_aios_ruil', person: 'respondent_id', period: 'period_id' },
];

const DIENSTEN_VAN_SQL = [
  ...PERSON_IN_POOL.map(
    (t) => `SELECT pl.type FROM ${t.from} x JOIN dienstrooster_pool pl ON pl.id = x.${t.pool} WHERE x.${t.person} = @person`
  ),
  ...PERSON_IN_PERIOD.map(
    (t) =>
      `SELECT pl.type FROM ${t.from.replace(/^(\w+)/, '$1 x')} JOIN dienstrooster_schedule_period sp ON sp.id = ${
        t.period.includes('.') ? t.period : `x.${t.period}`
      } JOIN dienstrooster_pool pl ON pl.id = sp.pool_id WHERE x.${t.person} = @person`
  ),
].join(' UNION ');

/** The diensten somebody has anything in: normally one, none for somebody new. */
export function dienstenVan(personId: string): Set<string> {
  return new Set((db.prepare(DIENSTEN_VAN_SQL).all({ person: personId }) as Array<{ type: string }>).map((r) => r.type));
}

/**
 * A participant of the other dienst: anything of theirs in another dienst's
 * pools or periods, at any time (also with every membership removed).
 */
export function staffMayAccessPerson(auth: AuthContext, personId: string): boolean {
  const dienst = visibleDienst(auth);
  if (dienst === null) return true;
  return !personHasOtherDienst(personId, dienst);
}

/** Whether somebody has anything of another dienst than this one (see PERSON_IN_POOL). */
export function personHasOtherDienst(personId: string, dienst: string): boolean {
  return [...dienstenVan(personId)].some((type) => type !== dienst);
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
