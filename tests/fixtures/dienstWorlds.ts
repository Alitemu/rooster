/**
 * Two complete worlds for the separation tests, one per dienst: a pool, a
 * published period with slots, two participants with a roster, a blocked
 * day, an absence, a part-time pattern, a swap request, a notice, a
 * hand-in and a correction (app/api/dienstSeparation.test.ts,
 * app/api/dienstSeparationOwn.test.ts). With the helpers to call every
 * route with a world's ids and to see whether anything of a world changed
 * or shows up in an answer.
 */

import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { readPart } from '@/lib/xlsx';

export type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export interface Route {
  path: string;
  method: (typeof METHODS)[number];
  handler: Handler;
}

/** Every handler of the route modules a test file globbed: every route.ts under app/api. */
export function routesFrom(routeModules: Record<string, Record<string, unknown>>): Route[] {
  return Object.entries(routeModules).flatMap(([file, mod]) => {
    const path = file.replace(/^\.\//, '').replace(/\/route\.ts$/, '');
    return METHODS.filter((m) => typeof mod[m] === 'function').map((method) => ({
      path,
      method,
      handler: mod[method] as Handler,
    }));
  });
}

export interface World {
  dienst: 'ACHTERWACHT' | 'AIOS';
  planner: string;
  pool: string;
  period: string;
  periodNaam: string;
  x: string;
  xCodenaam: string;
  yCodenaam: string;
  y: string;
  membership: string;
  slot: string;
  assignment: string;
  swap: string;
  // An AIOS swap (lib/aiosRuilen.ts), x asking y.
  ruil: string;
  absence: string;
  pattern: string;
  notice: string;
}


export const tag = crypto.randomUUID().slice(0, 6);

export function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

export function insert(table: string, row: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const cols = ['id', ...Object.keys(row)];
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
    id,
    ...Object.values(row).map((v) => v as never)
  );
  return id;
}

export const now = new Date().toISOString();

export function staff(rol: 'ADMIN' | 'PLANNER', dienst: 'ACHTERWACHT' | 'AIOS'): string {
  return insert('dienstrooster_person', {
    codenaam: `Dienst-${rol}-${dienst}-${tag}`,
    rol,
    actief: 1,
    dienst_type: dienst,
    aangemaakt_op: now,
  });
}

export function buildWorld(dienst: 'ACHTERWACHT' | 'AIOS'): World {
  const short = dienst === 'AIOS' ? 'aios' : 'staf';
  const planner = staff('PLANNER', dienst);
  const ruleset = insert('dienstrooster_ruleset', { naam: `Dienst-${short}-${tag}`, config_json: '{}', aangemaakt_op: now });
  const pool = insert('dienstrooster_pool', { naam: `Dienst-${short}-${tag}`, type: dienst, ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: pool, naam: 'Avond', teller: 'AVOND' });
  const periodNaam = `Periode-${short}-${tag}`;
  const period = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: periodNaam,
    start_datum: '2098-03-03',
    eind_datum: '2098-03-16',
    deadline: '2098-02-20T23:59',
    status: 'GEPUBLICEERD',
    bevroren_ruleset_json: '{"windowWeeks":1}',
    gepubliceerd_op: now,
    definitief_op: now,
    aangemaakt_op: now,
  });
  const slots: string[] = [];
  for (let d = 3; d <= 16; d++) {
    const datum = `2098-03-${String(d).padStart(2, '0')}`;
    slots.push(
      insert('dienstrooster_shift_slot', { period_id: period, shift_type_id: avond, datum, iso_jaar: 2098, iso_week: d <= 9 ? 10 : 11 })
    );
  }
  const participant = (name: string) => {
    const id = insert('dienstrooster_person', { codenaam: `${short}-${name}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_person_access_link', { person_id: id, token_hash: crypto.randomBytes(32).toString('hex'), aangemaakt_op: now });
    return id;
  };
  const x = participant('x');
  const y = participant('y');
  const membership = insert('dienstrooster_pool_membership', { person_id: x, pool_id: pool, deelnamefactor: 1, geldig_vanaf: '2098-01-01', geldig_tot: '2098-12-31' });
  insert('dienstrooster_pool_membership', { person_id: y, pool_id: pool, deelnamefactor: 1, geldig_vanaf: '2098-01-01', geldig_tot: '2098-12-31' });
  // Monday 3 March for x, Monday 10 March for y: 7 days apart, so the window of 1 holds.
  const assignment = insert('dienstrooster_assignment', { schedule_version_id: period, person_id: x, slot_id: slots[0], bron: 'SOLVER', aangemaakt_op: now });
  insert('dienstrooster_assignment', { schedule_version_id: period, person_id: y, slot_id: slots[7], bron: 'SOLVER', aangemaakt_op: now });
  insert('dienstrooster_availability', { person_id: x, slot_id: slots[2], blocking_level: 'ABSOLUUT', source: 'MANUAL', aangemaakt_op: now });
  const absence = insert('dienstrooster_absence', { person_id: x, van_datum: '2098-03-12', tot_datum: '2098-03-13', soort: 'VAKANTIE', aangemaakt_door: x, aangemaakt_op: now });
  const pattern = insert('dienstrooster_parttime_pattern', { person_id: x, weekdag: 'VR', frequentie: 'ELKE_WEEK', geldig_vanaf: '2098-01-01', geldig_tot: '2098-12-31', aangemaakt_door: x, aangemaakt_op: now });
  const swap = insert('dienstrooster_swap_request', {
    periode_id: period,
    aanvrager_person_id: x,
    aangeboden_slot_id: slots[0],
    gevraagde_slot_id: slots[7],
    respondent_person_id: y,
    status: 'PENDING',
    aangemaakt_op: now,
  });
  const ruil = insert('dienstrooster_aios_ruil', {
    period_id: period,
    aanvrager_id: x,
    respondent_id: y,
    aangeboden_json: JSON.stringify([slots[0]]),
    gevraagd_json: JSON.stringify([slots[7]]),
    status: 'IN_BEHANDELING',
    aangemaakt_op: now,
  });
  const notice = insert('dienstrooster_notification', { person_id: x, type: 'RUILVERZOEK', onderwerp: 'Ruilverzoek', inhoud: 'Ruilverzoek', aangemaakt_op: now });
  insert('dienstrooster_submission', { person_id: x, schedule_period_id: period, status: 'BEVESTIGD', aangemaakt_op: now });
  insert('dienstrooster_ledger_entry', {
    person_id: x,
    pool_id: pool,
    teller: 'AVOND',
    geldt_voor_periode_id: period,
    delta: 1,
    reden: 'Correctie',
    categorie: 'CORRECTIE',
    aangemaakt_door: planner,
    aangemaakt_op: now,
  });
  return {
    dienst,
    planner,
    pool,
    period,
    periodNaam,
    x,
    xCodenaam: `${short}-x-${tag}`,
    yCodenaam: `${short}-y-${tag}`,
    y,
    membership,
    slot: slots[0],
    assignment,
    swap,
    ruil,
    absence,
    pattern,
    notice,
  };
}

export function staffCookie(personId: string): string {
  const payload = { kind: 'staff', personId, sessionVersion: getSessionVersion(personId)! };
  return `${SESSION_COOKIE_NAME}=${createSessionToken(payload as never, STAFF_SESSION_MAX_AGE_SECONDS)}`;
}

/** Every [param] of a route filled with the world's own ids. */
export function fill(path: string, w: World): { url: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const value = (name: string): string => {
    switch (name) {
      case 'id':
        if (path.startsWith('person/') || path.startsWith('aios/deelnemer/')) return w.x;
        if (path.startsWith('planner/pool')) return w.pool;
        if (path.startsWith('admin/accounts')) return w.planner;
        return w.period;
      case 'period-id':
      case 'periodId':
        return w.period;
      case 'slotId':
        return w.slot;
      case 'assignment-id':
        return w.assignment;
      case 'membershipId':
        return w.membership;
      case 'swap-id':
        return w.swap;
      case 'ruilId':
        return w.ruil;
      case 'absenceId':
        return w.absence;
      case 'patternId':
        return w.pattern;
      case 'notif-id':
        return w.notice;
      default:
        throw new Error(`No fixture id for [${name}] in ${path}`);
    }
  };
  const url = path.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    params[name] = value(name);
    return params[name];
  });
  return { url: `http://localhost/api/${url}`, params };
}

export async function call(route: Route, w: World, asPerson: string): Promise<{ status: number; text: string }> {
  const { url, params } = fill(route.path, w);
  // A few GETs take the period from the query (the fellow route).
  const req = new NextRequest(`${url}?period_id=${w.period}`, {
    method: route.method,
    headers: { 'Content-Type': 'application/json', Cookie: staffCookie(asPerson) },
    body: route.method === 'GET' ? undefined : '{}',
  });
  const res = await route.handler(req, { params: Promise.resolve(params) });
  const text = res.headers.get('content-type')?.includes('json') ? await res.text() : '';
  return { status: res.status, text };
}

/**
 * Anything of the world that may not show up in an answer to the other
 * dienst. An id the request carried itself may come back in its "not
 * found" message: the caller knew it already.
 */
export function leaks(text: string, w: World, sent: string[] = []): string[] {
  return [w.period, w.periodNaam, w.pool, w.x, w.xCodenaam, w.y, w.yCodenaam].filter((s) => !sent.includes(s) && text.includes(s));
}

/**
 * Everything of a world a request could change: compared before and after
 * the other dienst's planner called every route, so a write that answered
 * 404 afterwards (or 200 with nothing in it) is caught too.
 */
export function fingerprint(w: World): string {
  const q = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as never[]));
  return JSON.stringify([
    q('SELECT * FROM dienstrooster_pool WHERE id = ?', w.pool),
    q('SELECT * FROM dienstrooster_pool_membership WHERE pool_id = ? ORDER BY id', w.pool),
    q('SELECT * FROM dienstrooster_schedule_period WHERE id = ?', w.period),
    q('SELECT * FROM dienstrooster_shift_slot WHERE period_id = ? ORDER BY id', w.period),
    q('SELECT * FROM dienstrooster_assignment WHERE schedule_version_id = ? ORDER BY id', w.period),
    q(
      `SELECT av.* FROM dienstrooster_availability av JOIN dienstrooster_shift_slot s ON s.id = av.slot_id
       WHERE s.period_id = ? ORDER BY av.id`,
      w.period
    ),
    q('SELECT * FROM dienstrooster_period_fellow WHERE period_id = ? ORDER BY id', w.period),
    q('SELECT * FROM dienstrooster_swap_request WHERE periode_id = ? ORDER BY id', w.period),
    q('SELECT * FROM dienstrooster_submission WHERE schedule_period_id = ? ORDER BY id', w.period),
    q('SELECT * FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ? ORDER BY id', w.period),
    q('SELECT * FROM dienstrooster_prior_assignment WHERE period_id = ? ORDER BY id', w.period),
    q('SELECT * FROM dienstrooster_person_access_link WHERE person_id IN (?, ?) ORDER BY id', w.x, w.y),
    q('SELECT * FROM dienstrooster_absence WHERE person_id = ? ORDER BY id', w.x),
    q('SELECT * FROM dienstrooster_parttime_pattern WHERE person_id = ? ORDER BY id', w.x),
    q('SELECT * FROM dienstrooster_notification WHERE person_id IN (?, ?) ORDER BY id', w.x, w.y),
    q('SELECT id, codenaam, actief, sessie_versie FROM dienstrooster_person WHERE id IN (?, ?) ORDER BY id', w.x, w.y),
  ]);
}

/**
 * A participant route with the planner's own participant, and the other
 * world's period, slot and swap everywhere else: in the url, the query and
 * the body. The participant is theirs to act for, the period is not.
 */
export async function callMixed(route: Route, own: World, other: World, asPerson: string): Promise<{ status: number; text: string }> {
  const { url, params } = fill(route.path, other);
  for (const name of Object.keys(params)) if (name === 'id') params[name] = own.x;
  const ownUrl = url.replace(`/api/person/${other.x}`, `/api/person/${own.x}`);
  const query = `?period_id=${other.period}&periode_id=${other.period}&periodId=${other.period}`;
  const body = JSON.stringify({
    period_id: other.period,
    periode_id: other.period,
    slot_id: other.slot,
    aangeboden_slot_id: other.slot,
    gevraagde_slot_id: other.slot,
    respondent_person_id: other.y,
    fellow: true,
    blocking_level: 'ABSOLUUT',
    gecontroleerd: true,
  });
  const req = new NextRequest(ownUrl + query, {
    method: route.method,
    headers: { 'Content-Type': 'application/json', Cookie: staffCookie(asPerson) },
    body: route.method === 'GET' ? undefined : body,
  });
  const res = await route.handler(req, { params: Promise.resolve(params) });
  const text = res.headers.get('content-type')?.includes('json') ? await res.text() : '';
  return { status: res.status, text };
}

/** The highest rowid of every table now: afterwards, deleteRowsAfter removes what a test file added. */
export function rowidSnapshot(): Map<string, number> {
  return new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
}

export function deleteRowsAfter(snapshot: Map<string, number>): void {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(snapshot.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** A participant's own session, as their personal link gives it. */
export function personCookie(personId: string): string {
  const payload = { kind: 'person', personId, sessionVersion: getSessionVersion(personId)! };
  return `${SESSION_COOKIE_NAME}=${createSessionToken(payload as never, STAFF_SESSION_MAX_AGE_SECONDS)}`;
}

/**
 * Everything an answer says, also a download: the JSON or text itself, and
 * for a workbook its strings and sheet names (lib/xlsxWrite.ts keeps every
 * text in sharedStrings.xml). Other binary answers say nothing readable.
 */
export async function answerText(res: Response): Promise<string> {
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('spreadsheetml')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return `${readPart(buf, 'xl/sharedStrings.xml') ?? ''}${readPart(buf, 'xl/workbook.xml') ?? ''}`;
  }
  if (type.includes('json') || type.startsWith('text/')) return res.text();
  return '';
}
