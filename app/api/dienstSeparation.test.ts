import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';

/**
 * The rule: the achterwacht's planner and the AIOS planner never see each
 * other's pools, periods, rosters or preferences (lib/dienstAccess.ts; the
 * planner's words: "Ze mogen elkaars rooster en voorkeuren niet inzien").
 *
 * Two complete worlds, one per dienst: a pool, a published period with
 * slots, two participants with a roster, a blocked day, an absence, a
 * part-time pattern, a swap request, a notice, a hand-in and a correction.
 * Every route file under app/api is loaded and every handler called - so a
 * route added later is covered without anyone remembering to - by each
 * world's planner with the other world's real ids. Each answers 401, 403
 * or 404 and never anything of the other world.
 *
 * A 404 proves nothing when the ids are wrong, so the same GETs by the
 * world's own planner and by the beheerder (who sees every dienst) must
 * find what they ask for.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const routeModules = import.meta.glob('./**/route.ts', { eager: true }) as unknown as Record<string, Record<string, unknown>>;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Open to anyone by design, or about one's own staff account only. */
const NOT_ABOUT_A_DIENST = (path: string) =>
  path.startsWith('auth/') || ['link-aanvragen'].includes(path);

/**
 * GETs that may answer 404 for the world's own planner with good ids: there
 * is simply nothing of that kind yet.
 */
const OWN_MAY_BE_EMPTY = new Set([
  // No undo is pending in a fresh world.
  'planner/period/[id]/assignments/pending-undo',
  'planner/pool/[id]/members/pending-undo',
  // No generation has run.
  'planner/period/[id]/generate-roster/status',
]);

interface Route {
  path: string;
  method: (typeof METHODS)[number];
  handler: Handler;
}

const routes: Route[] = Object.entries(routeModules).flatMap(([file, mod]) => {
  const path = file.replace(/^\.\//, '').replace(/\/route\.ts$/, '');
  return METHODS.filter((m) => typeof mod[m] === 'function').map((method) => ({
    path,
    method,
    handler: mod[method] as Handler,
  }));
});

interface World {
  dienst: 'ACHTERWACHT' | 'AIOS';
  planner: string;
  pool: string;
  period: string;
  periodNaam: string;
  x: string;
  xCodenaam: string;
  y: string;
  membership: string;
  slot: string;
  assignment: string;
  swap: string;
  absence: string;
  pattern: string;
  notice: string;
}

const tag = crypto.randomUUID().slice(0, 6);
let rowidsBefore: Map<string, number>;
const worlds: Record<'ACHTERWACHT' | 'AIOS', World> = {} as never;
let admin = '';

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

const now = new Date().toISOString();

function staff(rol: 'ADMIN' | 'PLANNER', dienst: 'ACHTERWACHT' | 'AIOS'): string {
  return insert('dienstrooster_person', {
    codenaam: `Dienst-${rol}-${dienst}-${tag}`,
    rol,
    actief: 1,
    dienst_type: dienst,
    aangemaakt_op: now,
  });
}

function buildWorld(dienst: 'ACHTERWACHT' | 'AIOS'): World {
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
    y,
    membership,
    slot: slots[0],
    assignment,
    swap,
    absence,
    pattern,
    notice,
  };
}

function staffCookie(personId: string): string {
  const payload = { kind: 'staff', personId, sessionVersion: getSessionVersion(personId)! };
  return `${SESSION_COOKIE_NAME}=${createSessionToken(payload as never, STAFF_SESSION_MAX_AGE_SECONDS)}`;
}

/** Every [param] of a route filled with the world's own ids. */
function fill(path: string, w: World): { url: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const value = (name: string): string => {
    switch (name) {
      case 'id':
        if (path.startsWith('person/')) return w.x;
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

async function call(route: Route, w: World, asPerson: string): Promise<{ status: number; text: string }> {
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
function leaks(text: string, w: World, sent: string[] = []): string[] {
  return [w.period, w.periodNaam, w.pool, w.x, w.xCodenaam, w.y].filter((s) => !sent.includes(s) && text.includes(s));
}

/**
 * Everything of a world a request could change: compared before and after
 * the other dienst's planner called every route, so a write that answered
 * 404 afterwards (or 200 with nothing in it) is caught too.
 */
function fingerprint(w: World): string {
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
async function callMixed(route: Route, own: World, other: World, asPerson: string): Promise<{ status: number; text: string }> {
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

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  worlds.ACHTERWACHT = buildWorld('ACHTERWACHT');
  worlds.AIOS = buildWorld('AIOS');
  admin = staff('ADMIN', 'ACHTERWACHT');
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

const aboutADienst = routes.filter((r) => !NOT_ABOUT_A_DIENST(r.path));
const withIds = aboutADienst.filter((r) => r.path.includes('['));
const withoutIds = aboutADienst.filter((r) => !r.path.includes('['));

describe('the achterwacht and the AIOS planner see nothing of each other', () => {
  it('finds the routes', () => {
    expect(withIds.length).toBeGreaterThan(80);
  });

  for (const [mine, theirs] of [
    ['ACHTERWACHT', 'AIOS'],
    ['AIOS', 'ACHTERWACHT'],
  ] as const) {
    let before = '';
    it(`takes the ${theirs}'s fingerprint`, () => {
      before = fingerprint(worlds[theirs]);
    });

    it.each(withIds.map((r) => [`${r.method} ${r.path}`, r] as const))(
      `the ${mine} planner, on the ${theirs}'s ids: %s`,
      async (_, route) => {
        const { status, text } = await call(route, worlds[theirs], worlds[mine].planner);
        expect([401, 403, 404], `status ${status}: ${text.slice(0, 200)}`).toContain(status);
        expect(leaks(text, worlds[theirs])).toEqual([]);
      }
    );

    it.each(withoutIds.map((r) => [`${r.method} ${r.path}`, r] as const))(
      `the ${mine} planner's lists hold nothing of the ${theirs}: %s`,
      async (_, route) => {
        const { text } = await call(route, worlds[theirs], worlds[mine].planner);
        expect(leaks(text, worlds[theirs])).toEqual([]);
      }
    );

    it.each(withIds.filter((r) => r.path.startsWith('person/')).map((r) => [`${r.method} ${r.path}`, r] as const))(
      `the ${mine} planner, for their own participant in the ${theirs}'s period: %s`,
      async (_, route) => {
        const { status, text } = await callMixed(route, worlds[mine], worlds[theirs], worlds[mine].planner);
        expect(status).toBeLessThan(500);
        const other = worlds[theirs];
        expect(leaks(text, other, [other.period, other.y])).toEqual([]);
      }
    );

    // Their own period or pool, the other world's assignment, slot or
    // membership under it: a route must look the second id up within the first.
    it.each(
      withIds
        .filter((r) => /^planner\/(period|pool)\/\[id\]\/.*\[/.test(r.path))
        .map((r) => [`${r.method} ${r.path}`, r] as const)
    )(`the ${mine} planner, the ${theirs}'s ids under their own period or pool: %s`, async (_, route) => {
      const own = worlds[mine];
      const other = worlds[theirs];
      const { url, params } = fill(route.path, other);
      const ownId = route.path.startsWith('planner/pool') ? own.pool : own.period;
      const theirId = route.path.startsWith('planner/pool') ? other.pool : other.period;
      params.id = ownId;
      const req = new NextRequest(url.replace(`/${theirId}/`, `/${ownId}/`), {
        method: route.method,
        headers: { 'Content-Type': 'application/json', Cookie: staffCookie(own.planner) },
        body: route.method === 'GET' ? undefined : JSON.stringify({ person_id: own.x, reason: 'Afspraak' }),
      });
      const res = await route.handler(req, { params: Promise.resolve(params) });
      const text = res.headers.get('content-type')?.includes('json') ? await res.text() : '';
      expect(res.status).toBeLessThan(500);
      expect(leaks(text, other)).toEqual([]);
    });

    it(`left the ${theirs} exactly as it was`, () => {
      expect(fingerprint(worlds[theirs])).toBe(before);
    });
  }

  const gets = withIds.filter((r) => r.method === 'GET' && !r.path.startsWith('admin/') && !OWN_MAY_BE_EMPTY.has(r.path));

  it.each(gets.map((r) => [`${r.method} ${r.path}`, r] as const))(
    "the ids are real: the AIOS planner finds the AIOS's own: %s",
    async (_, route) => {
      const { status, text } = await call(route, worlds.AIOS, worlds.AIOS.planner);
      expect(status, text.slice(0, 200)).not.toBe(404);
      expect(status).toBeLessThan(500);
    }
  );

  it.each(gets.map((r) => [`${r.method} ${r.path}`, r] as const))(
    'the beheerder sees both, the achterwacht: %s',
    async (_, route) => {
      const { status, text } = await call(route, worlds.ACHTERWACHT, admin);
      expect(status, text.slice(0, 200)).not.toBe(404);
      expect(status).toBeLessThan(500);
    }
  );
});

/**
 * Someone or something of the other dienst in the body, not the url: each
 * is no one to this planner, and the pools never share a participant
 * (whoever adds them, the beheerder too).
 */
describe('the other dienst named in the body', () => {
  const route = (path: string, method: (typeof METHODS)[number]) => {
    const found = routes.find((r) => r.path === path && r.method === method);
    if (!found) throw new Error(`no ${method} ${path}`);
    return found.handler;
  };
  const send = (handler: Handler, url: string, params: Record<string, string>, asPerson: string, body: unknown) =>
    handler(
      new NextRequest(`http://localhost/api/${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: staffCookie(asPerson) },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve(params) }
    );

  it("adding the achterwacht's participant to the AIOS pool is refused, for the beheerder too", async () => {
    const aios = worlds.AIOS;
    const staf = worlds.ACHTERWACHT;
    for (const who of [aios.planner, admin]) {
      const res = await send(route('planner/pool/[id]/members', 'POST'), `planner/pool/${aios.pool}/members`, { id: aios.pool }, who, {
        codenaam: staf.xCodenaam,
        geldig_vanaf: '2098-01-01',
        geldig_tot: '2098-12-31',
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('ANDERE_DIENST');
    }
    expect(db.prepare('SELECT 1 FROM dienstrooster_pool_membership WHERE pool_id = ? AND person_id = ?').get(aios.pool, staf.x)).toBeUndefined();
  });

  it("a period is not made in the other dienst's pool", async () => {
    const res = await send(route('planner/periods', 'POST'), 'planner/periods', {}, worlds.AIOS.planner, {
      naam: 'Binnendringer',
      pool_id: worlds.ACHTERWACHT.pool,
      start_datum: '2097-01-05',
      eind_datum: '2097-03-01',
      deadline: '2096-12-01T17:00',
    });
    expect(res.status).toBe(404);
    expect(db.prepare("SELECT 1 FROM dienstrooster_schedule_period WHERE naam = 'Binnendringer'").get()).toBeUndefined();
  });

  it("a prior assignment, by hand or imported, never names the other dienst's participant", async () => {
    const aios = worlds.AIOS;
    const staf = worlds.ACHTERWACHT;
    const patch = await route('periods/[id]/prior-assignments', 'PATCH')(
      new NextRequest(`http://localhost/api/periods/${aios.period}/prior-assignments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: staffCookie(aios.planner) },
        body: JSON.stringify({ datum: '2098-03-01', teller: 'AVOND', person_codenaam: staf.xCodenaam }),
      }),
      { params: Promise.resolve({ id: aios.period }) }
    );
    expect(patch.status).toBe(404);

    const imported = await send(
      route('periods/[id]/prior-assignments/import-csv', 'POST'),
      `periods/${aios.period}/prior-assignments/import-csv`,
      { id: aios.period },
      aios.planner,
      { rows: [{ datum: '2098-03-02', teller: 'AVOND', codenaam: staf.xCodenaam }] }
    );
    expect(imported.status).toBe(200);
    expect(JSON.stringify(await imported.json())).toContain('onbekende codenaam');
    expect(
      db.prepare('SELECT 1 FROM dienstrooster_prior_assignment WHERE period_id = ? AND person_id = ?').get(aios.period, staf.x)
    ).toBeUndefined();
  });

  it("the holiday import does not write the other dienst's participant", async () => {
    const res = await send(
      route('planner/period/[id]/import-holidays', 'POST'),
      `planner/period/${worlds.AIOS.period}/import-holidays`,
      { id: worlds.AIOS.period },
      worlds.AIOS.planner,
      { rows: [{ codenaam: worlds.ACHTERWACHT.xCodenaam, holiday_group: 'KERST', year: 2097 }] }
    );
    expect(JSON.stringify(await res.json())).toContain('Onbekende codenaam');
    expect(db.prepare('SELECT 1 FROM dienstrooster_holiday_history WHERE person_id = ?').get(worlds.ACHTERWACHT.x)).toBeUndefined();
  });
});
