import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';

/**
 * The rule (lib/aiosPeriod.ts): until the AIOS steps exist, no
 * achterwacht step runs on an AIOS period. It can be made, looked at,
 * renamed, put in the prullenbak and back, and taken through the steps up
 * to the preferences (ALLOWED); nothing else changes it, not even for the
 * beheerder, who sees every dienst. The achterwacht's steps
 * would invite the AIOS to a calendar of avond-, weekend- and
 * feestdagdiensten, publish or fill in their roster by the achterwacht's
 * rules.
 *
 * Two halves, so a route added later is covered without anyone
 * remembering to:
 * - every handler that changes something under a period's path (periods,
 *   planner/period, admin/period, the exports) asks aiosNotYetDenial, in
 *   its source;
 * - every changing handler under app/api, called by the beheerder with the
 *   AIOS period's ids in the path, the query and the body, leaves the AIOS
 *   period exactly as it was.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const routeModules = import.meta.glob('./**/route.ts', { eager: true }) as unknown as Record<string, Record<string, unknown>>;
const CHANGING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * What an AIOS period may go through now: rename, prullenbak, back, purge
 * (step 1), and from step 2 the steps up to the preferences: opening (by
 * its own rules, lib/aiosOpen.ts), the deadline, the invitations and
 * reminders (to the AIOS's own flow, lib/verzendlijstMail.ts), a link for
 * one person, closing and back to open. app/api/aiosOpen.test.ts holds
 * those.
 */
const ALLOWED = new Set([
  'periods/[id] PATCH',
  'periods/[id] DELETE',
  'periods/[id]/restore POST',
  'periods/[id]/purge POST',
  'periods/[id]/open POST',
  'periods/[id]/deadline PATCH',
  'periods/[id]/close POST',
  'periods/[id]/reopen POST',
  'planner/period/[id]/staff-links POST',
  'planner/period/[id]/auto-reminders PATCH',
  'planner/period/[id]/remind POST',
  'exports/invitations/[period-id] POST',
  'exports/invitations/[period-id]/send POST',
  'exports/reminders/[period-id] POST',
  'exports/reminders/[period-id]/send POST',
]);

/**
 * Step 2 (lib/aiosPreferences.ts): the AIOS's own preference routes, and
 * the absence and part-time routes, whose syncs follow the AIOS's rules in
 * an AIOS period (lib/aiosPreferences.test.ts holds those).
 */
const AIOS_STEP_2 = (r: { path: string }) =>
  r.path.startsWith('person/[id]/aios/') || r.path.startsWith('person/[id]/absences') || r.path.startsWith('person/[id]/parttime-patterns');

interface Route {
  path: string;
  method: (typeof CHANGING)[number];
  handler: Handler;
}

const routes: Route[] = Object.entries(routeModules).flatMap(([file, mod]) => {
  const p = file.replace(/^\.\//, '').replace(/\/route\.ts$/, '');
  return CHANGING.filter((m) => typeof mod[m] === 'function').map((method) => ({ path: p, method, handler: mod[method] as Handler }));
});

/** The source of one handler: from its `export async function` to the next. */
function handlerSource(routePath: string, method: string): string {
  const src = fs.readFileSync(path.join(__dirname, routePath, 'route.ts'), 'utf8');
  const start = src.indexOf(`export async function ${method}`);
  const next = src.indexOf('export async function', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

const tag = crypto.randomUUID().slice(0, 6);
const now = new Date().toISOString();
const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;

function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

function insert(table: string, row: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const cols = ['id', ...Object.keys(row)];
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
    id,
    ...Object.values(row).map((v) => v as never)
  );
  return id;
}

function cookie(): string {
  const payload = { kind: 'staff', personId: ids.beheerder, sessionVersion: getSessionVersion(ids.beheerder)! };
  return `${SESSION_COOKIE_NAME}=${createSessionToken(payload as never, STAFF_SESSION_MAX_AGE_SECONDS)}`;
}

/** Every [param] filled with the AIOS world's ids, `person` for a participant route's own. */
function fill(routePath: string, person: string): { url: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const value = (name: string): string => {
    switch (name) {
      case 'id':
        if (routePath.startsWith('person/')) return person;
        if (routePath.startsWith('planner/pool')) return ids.pool;
        if (routePath.startsWith('admin/accounts')) return ids.beheerder;
        return ids.period;
      case 'period-id':
      case 'periodId':
        return ids.period;
      case 'slotId':
        return ids.slot;
      case 'assignment-id':
        return ids.assignment;
      case 'membershipId':
        return ids.membership;
      case 'swap-id':
        return ids.swap;
      case 'absenceId':
        return ids.absence;
      case 'patternId':
        return ids.pattern;
      case 'notif-id':
        return ids.notice;
      default:
        throw new Error(`No fixture id for [${name}] in ${routePath}`);
    }
  };
  const url = routePath.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    params[name] = value(name);
    return params[name];
  });
  return { url: `http://localhost/api/${url}`, params };
}

/** The route with the AIOS ids everywhere a period, slot or person can go. */
async function call(route: Route, person: string): Promise<number> {
  const { url, params } = fill(route.path, person);
  const query = `?period_id=${ids.period}&periode_id=${ids.period}&periodId=${ids.period}`;
  const body = JSON.stringify({
    period_id: ids.period,
    periode_id: ids.period,
    slot_id: ids.otherSlot,
    person_id: ids.y,
    aangeboden_slot_id: ids.slot,
    gevraagde_slot_id: ids.otherSlot,
    respondent_person_id: ids.y,
    fellow: true,
    blocking_level: 'ABSOLUUT',
    gecontroleerd: true,
    deadline: '2097-12-01T17:00',
    auto_herinneren: false,
  });
  const req = new NextRequest(url + query, {
    method: route.method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie() },
    body,
  });
  const res = await route.handler(req, { params: Promise.resolve(params) });
  return res.status;
}

/** Everything of the AIOS period a request could change. */
function fingerprint(): string {
  const q = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as never[]));
  const p = ids.period;
  return JSON.stringify([
    q('SELECT * FROM dienstrooster_schedule_period WHERE id = ?', p),
    q('SELECT * FROM dienstrooster_shift_slot WHERE period_id = ? ORDER BY id', p),
    q('SELECT * FROM dienstrooster_shift_block WHERE period_id = ? ORDER BY id', p),
    q('SELECT * FROM dienstrooster_assignment WHERE schedule_version_id = ? ORDER BY id', p),
    q(
      `SELECT av.* FROM dienstrooster_availability av JOIN dienstrooster_shift_slot s ON s.id = av.slot_id
       WHERE s.period_id = ? ORDER BY av.id`,
      p
    ),
    q('SELECT * FROM dienstrooster_period_fellow WHERE period_id = ? ORDER BY id', p),
    q('SELECT * FROM dienstrooster_swap_request WHERE periode_id = ? ORDER BY id', p),
    q('SELECT * FROM dienstrooster_submission WHERE schedule_period_id = ? ORDER BY id', p),
    q('SELECT * FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ? ORDER BY id', p),
    q('SELECT * FROM dienstrooster_prior_assignment WHERE period_id = ? ORDER BY id', p),
    q('SELECT * FROM dienstrooster_period_excluded_day WHERE period_id = ? ORDER BY id', p),
    q('SELECT * FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ? ORDER BY id', p),
    q('SELECT * FROM dienstrooster_reminder_schedule WHERE period_id = ? ORDER BY id', p),
    q('SELECT * FROM dienstrooster_mail_queue WHERE period_id = ? ORDER BY id', p),
    q('SELECT * FROM dienstrooster_notification WHERE periode_id = ? ORDER BY id', p),
    q('SELECT * FROM dienstrooster_pending_undo WHERE scope_id = ? ORDER BY id', p),
  ]);
}

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  ids.beheerder = insert('dienstrooster_person', { codenaam: `AiosNog-admin-${tag}`, rol: 'ADMIN', actief: 1, dienst_type: 'ACHTERWACHT', aangemaakt_op: now });
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosNog-${tag}`, config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: `AiosNog-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, ids.pool);

  // A published AIOS quarter, as if the later steps had run: with its
  // diensten, a roster, a blocked dienst, a swap, a hand-in and a
  // correction, so a route without the guard has something to change.
  const q = aiosQuarter(2097, 1);
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: `AiosNog-${tag}`,
    start_datum: q.start_datum,
    eind_datum: q.eind_datum,
    deadline: '2096-11-01T17:00',
    status: 'GEPUBLICEERD',
    bevroren_ruleset_json: '{"windowWeeks":1}',
    gepubliceerd_op: now,
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(ids.period, aiosShiftTypes(ids.pool)!, q.start_datum, q.eind_datum))();
  const slots = db
    .prepare(`SELECT id FROM dienstrooster_shift_slot WHERE period_id = ? ORDER BY datum, rowid`)
    .all(ids.period) as Array<{ id: string }>;
  ids.slot = slots[0].id;
  ids.otherSlot = slots[30].id;

  const participant = (name: string) => {
    const id = insert('dienstrooster_person', { codenaam: `aios-${name}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_person_access_link', { person_id: id, token_hash: crypto.randomBytes(32).toString('hex'), aangemaakt_op: now });
    return id;
  };
  ids.x = participant('x');
  ids.y = participant('y');
  ids.membership = insert('dienstrooster_pool_membership', { person_id: ids.x, pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2096-01-01', geldig_tot: '2098-12-31' });
  insert('dienstrooster_pool_membership', { person_id: ids.y, pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2096-01-01', geldig_tot: '2098-12-31' });
  ids.assignment = insert('dienstrooster_assignment', { schedule_version_id: ids.period, person_id: ids.x, slot_id: ids.slot, bron: 'SOLVER', aangemaakt_op: now });
  insert('dienstrooster_availability', { person_id: ids.x, slot_id: slots[5].id, blocking_level: 'ABSOLUUT', source: 'MANUAL', aangemaakt_op: now });
  ids.absence = insert('dienstrooster_absence', { person_id: ids.x, van_datum: '2097-02-01', tot_datum: '2097-02-02', soort: 'VAKANTIE', aangemaakt_door: ids.x, aangemaakt_op: now });
  ids.pattern = insert('dienstrooster_parttime_pattern', { person_id: ids.x, weekdag: 'VR', frequentie: 'ELKE_WEEK', geldig_vanaf: '2096-01-01', geldig_tot: '2098-12-31', aangemaakt_door: ids.x, aangemaakt_op: now });
  ids.swap = insert('dienstrooster_swap_request', {
    periode_id: ids.period,
    aanvrager_person_id: ids.x,
    aangeboden_slot_id: ids.slot,
    gevraagde_slot_id: ids.otherSlot,
    respondent_person_id: ids.y,
    status: 'PENDING',
    aangemaakt_op: now,
  });
  ids.notice = insert('dienstrooster_notification', { person_id: ids.x, type: 'RUILVERZOEK', onderwerp: 'Ruilverzoek', inhoud: 'Ruilverzoek', aangemaakt_op: now });
  insert('dienstrooster_submission', { person_id: ids.x, schedule_period_id: ids.period, status: 'BEVESTIGD', aangemaakt_op: now });
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('no achterwacht step runs on an AIOS period yet', () => {
  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(60);
  });

  const onAPeriodsPath = (p: string) =>
    p.startsWith('periods/[id]') || p.startsWith('planner/period/[id]') || p.startsWith('admin/period/[id]') || p.includes('[period-id]');

  it('asks aiosNotYetDenial in every changing route under a period\'s path', () => {
    const missing = routes
      .filter((r) => !ALLOWED.has(`${r.path} ${r.method}`) && onAPeriodsPath(r.path))
      .filter((r) => !handlerSource(r.path, r.method).includes('aiosNotYetDenial('))
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  // Every route a period can reach: in its path, or through the body,
  // query or slot of a participant route. Others (accounts, mail settings,
  // the pool's members) have no period to change.
  const aboutAPeriod = routes.filter(
    (r) =>
      !ALLOWED.has(`${r.path} ${r.method}`) &&
      !AIOS_STEP_2(r) &&
      (onAPeriodsPath(r.path) || r.path.startsWith('person/') || r.path === 'planner/periods')
  );

  // Open (where the participant's routes write) and published (where the
  // roster and swap routes do): a route that refuses a period in the wrong
  // status would pass in the other without its guard.
  describe.each(['OPEN', 'GEPUBLICEERD'])('with the AIOS period %s', (status) => {
    beforeAll(() => {
      db.prepare('UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?').run(status, ids.period);
    });

    it.each(aboutAPeriod.map((r) => [`${r.method} ${r.path}`, r] as const))(
      'leaves the AIOS period as it was: %s',
      async (_name, route) => {
        // A participant route as x and as y: who asked for the swap and
        // who is asked can do different things with it.
        for (const person of route.path.startsWith('person/') ? [ids.x, ids.y] : [ids.x]) {
          const before = fingerprint();
          await call(route, person);
          expect(fingerprint(), `${route.method} ${route.path} as ${person === ids.x ? 'x' : 'y'} changed the AIOS period`).toBe(before);
        }
      }
    );
  });
});
