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
  leaks,
  routesFrom,
  rowidSnapshot,
  staff,
  staffCookie,
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
  // The participant's screens are the achterwacht's: they find nothing of
  // an AIOS period until its own step (lib/periodAccess.ts periodUsableFor,
  // app/api/aiosNotYet.test.ts). The other direction still holds them.
  const NOT_YET_FOR_AN_AIOS_PERIOD = new Set([
    'person/[id]/fellow',
    'person/[id]/parttime-check',
    'person/[id]/preferences/[periodId]',
    'person/[id]/preferences/[periodId]/coverage',
    'person/[id]/roster/[period-id]',
    'person/[id]/roster/[period-id]/others',
  ]);

  it.each(gets.filter((r) => !NOT_YET_FOR_AN_AIOS_PERIOD.has(r.path)).map((r) => [`${r.method} ${r.path}`, r] as const))(
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
