import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fc from 'fast-check';
import fs from 'fs';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter, type Kwartaal } from '@/lib/aiosQuarter';
import { deleteRowsAfter, insert, now, personCookie, rowidSnapshot, staff, staffCookie, tag } from '../../../tests/fixtures/dienstWorlds';

/**
 * The rule of app/api/routeInput.test.ts for the AIOS's own routes: whatever
 * a signed-in user sends, no route answers 500. That sweep calls them with
 * an achterwacht period and participant, so every AIOS route stopped at
 * "not found" and its input was never tried (the full audit, 0.86.0).
 *
 * Here an AIOS world: a quarter in each status (concept, open, gesloten,
 * gegenereerd, gepubliceerd), two AIOS with a link, a part-time day, leave,
 * a roster and an open swap request. Every mutating AIOS route is called
 * with each quarter, as the beheerder or (on the participant routes) the
 * AIOS, with bodies of the fields the AIOS's code reads and odd values.
 * The AIOS's solver is a stand-in that answers at once. What the routes
 * write is rolled back afterwards.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const routeModules = import.meta.glob('./**/route.ts', { eager: true }) as unknown as Record<string, Record<string, unknown>>;
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const STATUSSEN = ['CONCEPT', 'OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD'] as const;

let snapshot: Map<string, number>;
let server: http.Server;
const bewaardeUrl = process.env.AIOS_SOLVER_URL;
const w = {} as {
  pool: string;
  admin: string;
  x: string;
  y: string;
  pattern: string;
  absence: string;
  periodes: Record<(typeof STATUSSEN)[number], string>;
  slot: Record<string, string>;
  blok: Record<string, string>;
  ruil: string;
};

beforeAll(async () => {
  snapshot = rowidSnapshot();
  server = http.createServer((rq, rs) => {
    rq.resume();
    rq.on('end', () => {
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ status: 'HAALBAAR', toewijzingen: [], leeg: [], per_aios: [], tijd_seconden: 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.AIOS_SOLVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  w.admin = staff('ADMIN', 'AIOS');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosInvoer-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosInvoer-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  const aios = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: `aiosinvoer-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2096-01-01', geldig_tot: '2099-12-31' });
    return id;
  };
  w.x = aios('x');
  w.y = aios('y');
  w.periodes = {} as never;
  w.slot = {};
  w.blok = {};
  STATUSSEN.forEach((status, i) => {
    const q = aiosQuarter(2097 + Math.floor(i / 4), ((i % 4) + 1) as Kwartaal);
    const id = insert('dienstrooster_schedule_period', {
      pool_id: w.pool,
      naam: `AiosInvoer ${status}-${tag}`,
      start_datum: q.start_datum,
      eind_datum: q.eind_datum,
      deadline: '2096-11-01T17:00',
      status,
      auto_herinneren: 0,
      aangemaakt_op: now,
    });
    db.transaction(() => persistAiosSlots(id, aiosShiftTypes(w.pool)!, q.start_datum, q.eind_datum))();
    w.periodes[status] = id;
    for (const p of [w.x, w.y]) {
      insert('dienstrooster_person_access_link', { person_id: p, token_hash: `aiosinvoer-${p}-${id}`, geldt_voor_periode_id: id, aangemaakt_op: now });
    }
    const nachten = db
      .prepare(
        `SELECT sl.id, sl.shift_block_id AS blok FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
         WHERE sl.period_id = ? AND st.code = 'ND' ORDER BY sl.datum`
      )
      .all(id) as Array<{ id: string; blok: string }>;
    w.slot[id] = nachten[0].id;
    w.blok[id] = nachten[0].blok;
    if (status === 'GEGENEREERD' || status === 'GEPUBLICEERD') {
      // Every night: x the first block of each pair, y the second.
      const blokken = [...new Set(nachten.map((n) => n.blok))];
      for (const n of nachten) {
        insert('dienstrooster_assignment', {
          schedule_version_id: id,
          person_id: blokken.indexOf(n.blok) % 2 === 0 ? w.x : w.y,
          slot_id: n.id,
          bron: 'SOLVER',
          row_version: 1,
          aangemaakt_op: now,
        });
      }
    }
  });
  const gepubliceerd = w.periodes.GEPUBLICEERD;
  const blokken = (db.prepare('SELECT DISTINCT shift_block_id AS b FROM dienstrooster_shift_slot WHERE period_id = ? AND shift_block_id IS NOT NULL').all(gepubliceerd) as Array<{ b: string }>).map((r) => r.b);
  const diensten = (blok: string) => (db.prepare('SELECT id FROM dienstrooster_shift_slot WHERE shift_block_id = ? ORDER BY datum').all(blok) as Array<{ id: string }>).map((r) => r.id);
  w.ruil = insert('dienstrooster_aios_ruil', {
    period_id: gepubliceerd,
    aanvrager_id: w.x,
    respondent_id: w.y,
    aangeboden_json: JSON.stringify(diensten(blokken[blokken.length - 2])),
    gevraagd_json: JSON.stringify(diensten(blokken[blokken.length - 1])),
    status: 'IN_BEHANDELING',
    aangemaakt_op: now,
  });
  w.pattern = insert('dienstrooster_parttime_pattern', { person_id: w.x, weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2097-01-01', geldig_tot: '2098-12-31', aangemaakt_door: w.x, aangemaakt_op: now });
  w.absence = insert('dienstrooster_absence', { person_id: w.x, van_datum: '2097-05-06', tot_datum: '2097-05-08', soort: 'VAKANTIE', aangemaakt_door: w.x, aangemaakt_op: now });
});

afterAll(async () => {
  process.env.AIOS_SOLVER_URL = bewaardeUrl;
  // A generation started by a call may still be writing: give it a moment.
  await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => server.close(r));
  deleteRowsAfter(snapshot);
});

/** The fields the AIOS's code reads from a body: its routes' own and the libraries' they pass the body to. */
const VELDEN = (() => {
  const bronnen = [
    ...fs.readdirSync(path.join(__dirname, '../../../lib')).filter((f) => /^aios.*\.ts$/.test(f) && !f.endsWith('.test.ts')).map((f) => path.join(__dirname, '../../../lib', f)),
    ...Object.keys(routeModules).map((f) => path.join(__dirname, f)),
  ];
  const velden = new Set<string>();
  for (const bron of bronnen) {
    const src = fs.readFileSync(bron, 'utf8');
    for (const m of src.matchAll(/\b(?:body|invoer|input)\??\.(\w+)/g)) velden.add(m[1]);
    for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*(?:body|await parseJsonBody)/g)) {
      for (const k of m[1].split(',')) {
        const naam = k.split(/[:=]/)[0].trim();
        if (/^\w+$/.test(naam)) velden.add(naam);
      }
    }
  }
  for (const weg of ['length', 'ok', 'message', 'status', 'id']) velden.delete(weg);
  return [...velden];
})();

const waarde = (periodId: string) =>
  fc.oneof(
    fc.constantFrom<unknown>(null, true, false, 0, -1, 1.5, 1e12, '', ' ', 'x', 'NaN', '2097-02-30', '2097-04-07', '2096-12-31T23:59', 'ABSOLUUT', 'LIEVER_NIET', 'MA', 'ELKE_WEEK', 'VAKANTIE', [], {}, ['x'], { a: 1 }, [{}], 'x'.repeat(5000), [{ dienst_id: 'x', aios_id: null, was: null }]),
    fc.constantFrom(w.x, w.y, periodId, w.slot[periodId], w.blok[periodId], w.ruil, `blok:${w.blok[periodId]}`, `dienst:${w.slot[periodId]}`),
    fc.string({ maxLength: 20 }),
    fc.integer()
  );

// Destructive ones last, so the quarters keep their status for the rest.
const LAATST = /verwijderen|intrekken|definitief|heropenen|sluiten|openen|publiceren|genereren|DELETE/;
const routes = Object.entries(routeModules)
  .flatMap(([file, mod]) => {
    const route = `aios/${file.replace(/^\.\//, '').replace(/\/route\.ts$/, '')}`;
    return MUTATING.filter((m) => typeof mod[m] === 'function').map((method) => ({ route, method, handler: mod[method] as Handler }));
  })
  // Asked for from the start page and rate-limited: its own test.
  .filter((r) => r.route !== 'aios/link-aanvragen')
  .sort((a, b) => Number(LAATST.test(`${a.method} ${a.route}`)) - Number(LAATST.test(`${b.method} ${b.route}`)));

function pad(route: string, periodId: string): { url: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const url = route.replace(/\[([^\]]+)\]/g, (_, naam: string) => {
    const v: Record<string, string> = {
      id: route.startsWith('aios/deelnemer/') ? w.x : periodId,
      periodId,
      slotId: w.slot[periodId],
      ruilId: w.ruil,
      patternId: w.pattern,
      absenceId: w.absence,
    };
    params[naam] = v[naam] ?? crypto.randomUUID();
    return params[naam];
  });
  return { url: `http://localhost/api/${url}`, params };
}

describe('no AIOS route answers 500 to wrong input', () => {
  it('finds the routes and the fields', () => {
    expect(routes.length).toBeGreaterThan(25);
    expect(VELDEN).toEqual(expect.arrayContaining(['weekdag', 'van_datum', 'deadline', 'wijzigingen', 'toelichting', 'bestand']));
  });

  it.each(routes.map((r) => [`${r.method} ${r.route}`, r] as const))(
    '%s',
    async (_, r) => {
      const wie = r.route.startsWith('aios/deelnemer/') ? personCookie(w.x) : staffCookie(w.admin);
      for (const status of STATUSSEN) {
        const periodId = w.periodes[status];
        await fc.assert(
          fc.asyncProperty(fc.dictionary(fc.constantFrom(...VELDEN), waarde(periodId), { maxKeys: 6 }), async (body) => {
            const { url, params } = pad(r.route, periodId);
            const req = new NextRequest(url, { method: r.method, headers: { 'Content-Type': 'application/json', Cookie: wie }, body: JSON.stringify(body) });
            let antwoord: number;
            try {
              antwoord = (await r.handler(req, { params: Promise.resolve(params) })).status;
            } catch (error) {
              throw new Error(`threw ${(error as Error).message} in ${status} for ${JSON.stringify(body).slice(0, 200)}`);
            }
            expect(antwoord, `${status}: ${JSON.stringify(body).slice(0, 300)}`).not.toBe(500);
          }),
          { numRuns: 12 }
        );
      }
    },
    120_000
  );
});
