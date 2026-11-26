import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import {
  METHODS,
  buildWorld,
  call,
  callMixed,
  deleteRowsAfter,
  fill,
  fingerprint,
  insert,
  leaks,
  now,
  personCookie,
  routesFrom,
  rowidSnapshot,
  staff,
  staffCookie,
  tag,
  type Handler,
  type World,
} from '../../tests/fixtures/dienstWorlds';

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


const routes = routesFrom(import.meta.glob('./**/route.ts', { eager: true }) as unknown as Record<string, Record<string, unknown>>);

/** Open to anyone by design, or about one's own staff account only. */
const NOT_ABOUT_A_DIENST = (path: string) =>
  path.startsWith('auth/') || ['link-aanvragen', 'aios/link-aanvragen', 'aios/mail-instellingen'].includes(path);

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

let rowidsBefore: Map<string, number>;
const worlds: Record<'ACHTERWACHT' | 'AIOS', World> = {} as never;
let admin = '';

beforeAll(() => {
  rowidsBefore = rowidSnapshot();
  worlds.ACHTERWACHT = buildWorld('ACHTERWACHT');
  worlds.AIOS = buildWorld('AIOS');
  admin = staff('ADMIN', 'ACHTERWACHT');
});

afterAll(() => deleteRowsAfter(rowidsBefore));

const aboutADienst = routes.filter((r) => !NOT_ABOUT_A_DIENST(r.path));
const withIds = aboutADienst.filter((r) => r.path.includes('['));
const withoutIds = aboutADienst.filter((r) => !r.path.includes('['));

describe('the achterwacht and the AIOS planner see nothing of each other', () => {
  it('finds the routes', () => {
    // 159 with an id and 187 routes in all in 0.106.0: the floors sit just under, so a whole folder dropping out of the glob is seen.
    expect(withIds.length).toBeGreaterThan(150);
    expect(routes.length).toBeGreaterThan(180);
    expect(routes.filter((r) => r.path.startsWith('aios/')).length).toBeGreaterThan(55);
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

    it.each(withIds.filter((r) => (r.path.startsWith('person/') || r.path.startsWith('aios/deelnemer/'))).map((r) => [`${r.method} ${r.path}`, r] as const))(
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
  // The achterwacht's participant routes are not the AIOS's: an AIOS keeps
  // to app/api/aios/deelnemer (lib/aiosPeriod.ts aiosPersonDenial, the
  // describe below). The other direction still holds them.
  const ONLY_FOR_THE_ACHTERWACHT = (path: string) => path.startsWith('person/');

  it.each(gets.filter((r) => !ONLY_FOR_THE_ACHTERWACHT(r.path)).map((r) => [`${r.method} ${r.path}`, r] as const))(
    "the ids are real: the AIOS planner finds the AIOS's own: %s",
    async (_, route) => {
      const { status, text } = await call(route, worlds.AIOS, worlds.AIOS.planner);
      expect(status, text.slice(0, 200)).not.toBe(404);
      expect(status).toBeLessThan(500);
    }
  );

  // The AIOS's own routes (app/api/aios) find nothing in an achterwacht
  // period: they only ever load an AIOS one.
  const ONLY_FOR_THE_AIOS = (path: string) => path.startsWith('aios/');

  it.each(gets.filter((r) => !ONLY_FOR_THE_AIOS(r.path)).map((r) => [`${r.method} ${r.path}`, r] as const))(
    'the beheerder sees both, the achterwacht: %s',
    async (_, route) => {
      const { status, text } = await call(route, worlds.ACHTERWACHT, admin);
      expect(status, text.slice(0, 200)).not.toBe(404);
      expect(status).toBeLessThan(500);
    }
  );
});

/**
 * A participant's routes are their own dienst's: an absence, a part-time
 * day or a notice of the achterwacht's participant written through the
 * AIOS's routes got the AIOS's sync only (and removing their absence there
 * left its marks in the achterwacht's open period), and the other way
 * round. Every participant route of the other dienst answers 404 about
 * them, whoever asks (they themselves, their planner, the beheerder) and
 * with whichever world's period, slot or swap (lib/aiosPeriod.ts
 * aiosPersonDenial, lib/aiosToegang.ts geenAiosDenial).
 */
describe("a participant's routes are those of their own dienst", () => {
  const VAN_DE_ANDERE = { ACHTERWACHT: 'aios/deelnemer/', AIOS: 'person/' } as const;
  const body = (w: World) =>
    JSON.stringify({
      weekdag: 'DI',
      frequentie: 'ELKE_WEEK',
      geldig_vanaf: '2096-01-01',
      geldig_tot: '2096-12-31',
      van_datum: '2096-03-02',
      tot_datum: '2096-03-04',
      soort: 'VAKANTIE',
      gecontroleerd: true,
      period_id: w.period,
      periode_id: w.period,
      slot_id: w.slot,
      blocking_level: 'ABSOLUUT',
      level: 'ABSOLUUT',
      fellow: true,
    });

  for (const mine of ['ACHTERWACHT', 'AIOS'] as const) {
    it(`refuses the ${mine} participant on every participant route of the other dienst`, async () => {
      const own = worlds[mine];
      const other = worlds[mine === 'AIOS' ? 'ACHTERWACHT' : 'AIOS'];
      const theirs = routes.filter((r) => r.path.startsWith(VAN_DE_ANDERE[mine]));
      expect(theirs.length).toBeGreaterThan(10);
      const before = fingerprint(own) + fingerprint(other);
      const open: string[] = [];
      for (const route of theirs) {
        for (const ids of [own, other]) {
          for (const [who, cookie] of [
            ['themselves', personCookie(own.x)],
            ['their planner', staffCookie(own.planner)],
            ['the beheerder', staffCookie(admin)],
          ] as const) {
            const { url, params } = fill(route.path, ids);
            params.id = own.x;
            const res = await route.handler(
              new NextRequest(`${url.replace(`/${ids.x}`, `/${own.x}`)}?period_id=${ids.period}`, {
                method: route.method,
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: route.method === 'GET' ? undefined : body(ids),
              }),
              { params: Promise.resolve(params) }
            );
            if (res.status !== 404) open.push(`${route.method} ${route.path}, ${who}, ${ids.dienst}'s ids: ${res.status}`);
          }
        }
      }
      expect(open).toEqual([]);
      expect(fingerprint(own) + fingerprint(other)).toBe(before);
    });
  }

  it("the AIOS planner, for someone in no pool, still gets nothing of the achterwacht's period", async () => {
    // Of neither dienst, so both checks above let them through: the period decides (lib/periodAccess.ts).
    const niemand = insert('dienstrooster_person', { codenaam: `niemand-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    const staf = worlds.ACHTERWACHT;
    const rooster = routes.find((r) => r.path === 'person/[id]/roster/[period-id]' && r.method === 'GET')!;
    const res = await rooster.handler(
      new NextRequest(`http://localhost/api/person/${niemand}/roster/${staf.period}`, { headers: { Cookie: staffCookie(worlds.AIOS.planner) } }),
      { params: Promise.resolve({ id: niemand, 'period-id': staf.period }) }
    );
    const text = await res.text();
    expect([403, 404]).toContain(res.status);
    expect(leaks(text, staf, [staf.period])).toEqual([]);
  });
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

  it("an AIOS stays out of the achterwacht's pools, also once removed from every pool: their link, mark, dienst or hand-in says whose they were", async () => {
    const aios = worlds.AIOS;
    const staf = worlds.ACHTERWACHT;
    const vrijeDienst = db
      .prepare('SELECT id FROM dienstrooster_shift_slot WHERE period_id = ? AND id NOT IN (SELECT slot_id FROM dienstrooster_assignment) LIMIT 1')
      .get(aios.period) as { id: string };
    const sporen: Record<string, (personId: string) => void> = {
      lid: (p) => insert('dienstrooster_pool_membership', { person_id: p, pool_id: aios.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2090-12-31' }),
      link: (p) => insert('dienstrooster_person_access_link', { person_id: p, token_hash: `weg-${p}`, geldt_voor_periode_id: aios.period, aangemaakt_op: now }),
      markering: (p) => insert('dienstrooster_availability', { person_id: p, slot_id: aios.slot, blocking_level: 'ABSOLUUT', source: 'MANUAL', aangemaakt_op: now }),
      dienst: (p) => insert('dienstrooster_assignment', { schedule_version_id: aios.period, person_id: p, slot_id: vrijeDienst.id, bron: 'MANUAL', aangemaakt_op: now }),
      ingediend: (p) => insert('dienstrooster_submission', { person_id: p, schedule_period_id: aios.period, status: 'BEVESTIGD', aangemaakt_op: now }),
    };
    for (const [spoor, leg] of Object.entries(sporen)) {
      const codenaam = `weg-${spoor}-${tag}`;
      const p = insert('dienstrooster_person', { codenaam, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
      leg(p);
      const lid = (pool: string, who: string) =>
        send(route('planner/pool/[id]/members', 'POST'), `planner/pool/${pool}/members`, { id: pool }, who, { codenaam, geldig_vanaf: '2098-01-01', geldig_tot: '2098-12-31' });
      for (const who of [staf.planner, admin]) {
        const res = await lid(staf.pool, who);
        expect(res.status, spoor).toBe(409);
        expect((await res.json()).error.code).toBe('ANDERE_DIENST');
      }
      // Back to their own dienst they may.
      expect((await lid(aios.pool, aios.planner)).status, spoor).toBe(201);
    }
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

  // In the achterwacht's period: an AIOS period takes no achterwacht step
  // at all yet (lib/aiosPeriod.ts), so the AIOS participant is the one
  // named.
  it("a prior assignment, by hand or imported, never names the other dienst's participant", async () => {
    const aios = worlds.AIOS;
    const staf = worlds.ACHTERWACHT;
    const patch = await route('periods/[id]/prior-assignments', 'PATCH')(
      new NextRequest(`http://localhost/api/periods/${staf.period}/prior-assignments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: staffCookie(staf.planner) },
        body: JSON.stringify({ datum: '2098-03-01', teller: 'AVOND', person_codenaam: aios.xCodenaam }),
      }),
      { params: Promise.resolve({ id: staf.period }) }
    );
    expect(patch.status).toBe(404);

    const imported = await send(
      route('periods/[id]/prior-assignments/import-csv', 'POST'),
      `periods/${staf.period}/prior-assignments/import-csv`,
      { id: staf.period },
      staf.planner,
      { rows: [{ datum: '2098-03-02', teller: 'AVOND', codenaam: aios.xCodenaam }] }
    );
    expect(imported.status).toBe(200);
    expect(JSON.stringify(await imported.json())).toContain('onbekende codenaam');
    expect(
      db.prepare('SELECT 1 FROM dienstrooster_prior_assignment WHERE period_id = ? AND person_id = ?').get(staf.period, aios.x)
    ).toBeUndefined();
  });

  it("the holiday import does not write the other dienst's participant", async () => {
    const res = await send(
      route('planner/period/[id]/import-holidays', 'POST'),
      `planner/period/${worlds.ACHTERWACHT.period}/import-holidays`,
      { id: worlds.ACHTERWACHT.period },
      worlds.ACHTERWACHT.planner,
      { rows: [{ codenaam: worlds.AIOS.xCodenaam, holiday_group: 'KERST', year: 2097 }] }
    );
    expect(JSON.stringify(await res.json())).toContain('Onbekende codenaam');
    expect(db.prepare('SELECT 1 FROM dienstrooster_holiday_history WHERE person_id = ?').get(worlds.AIOS.x)).toBeUndefined();
  });
});
