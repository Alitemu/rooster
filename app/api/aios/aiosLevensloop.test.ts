import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fc from 'fast-check';
import http from 'http';
import type { AddressInfo } from 'net';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { aiosGeneratieJob } from '@/lib/aiosGenereren';
import { POST as openen } from './periode/[id]/openen/route';
import { POST as sluiten } from './periode/[id]/sluiten/route';
import { POST as heropenen } from './periode/[id]/heropenen/route';
import { PATCH as deadline } from './periode/[id]/deadline/route';
import { POST as genereren } from './periode/[id]/genereren/route';
import { POST as roosterVerwijderen } from './periode/[id]/rooster-verwijderen/route';
import { POST as publiceren } from './periode/[id]/publiceren/route';
import { POST as definitief } from './periode/[id]/definitief-maken/route';
import { POST as intrekken } from './periode/[id]/publicatie-intrekken/route';
import { PUT as voortgangstoets } from './periode/[id]/voortgangstoets/route';
import { GET as eigenRooster } from './deelnemer/[id]/periode/[periodId]/rooster/route';
import { deleteRowsAfter, insert, now, personCookie, rowidSnapshot, staff, staffCookie, tag } from '../../../tests/fixtures/dienstWorlds';

/**
 * The life of an AIOS quarter, in any order the planner clicks (the full
 * audit, 0.86.0): open, close, open again, move the deadline, make the
 * roster, delete it, publish, make it definitief, withdraw it, set the
 * voortgangstoets. Whatever the order:
 * - no step answers 500;
 * - a refused step changes nothing: not the period, not the roster;
 * - the steps go only where the status allows (concept to open, open to
 *   gesloten and back, gesloten to gegenereerd and back, gegenereerd to
 *   gepubliceerd and back), and definitief only while published;
 * - a roster only in gegenereerd or gepubliceerd, every dienst of it with an
 *   AIOS (the stand-in solver fills them all);
 * - the version only goes up, with every change of status;
 * - the AIOS sees their roster only while it is published.
 * The voortgangstoets takes a night out and puts it back: no dienst may be
 * left without its AIOS or with two. In a roster already made the night
 * that comes back goes to the AIOS of the rest of its block
 * (lib/aiosVoortgangstoets.ts); it stayed open.
 */

let snapshot: Map<string, number>;
let server: http.Server;
const bewaardeUrl = process.env.AIOS_SOLVER_URL;
const w = {} as { pool: string; planner: string; x: string; y: string; start: string; eind: string };
const Q = aiosQuarter(2096, 3);

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  snapshot = rowidSnapshot();
  // The stand-in solver: a block to one AIOS, the next to the other, single diensten in turn.
  server = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => (body += c));
    rq.on('end', () => {
      const invoer = JSON.parse(body) as { diensten: Array<{ id: string; blok_id: string | null }>; aios: Array<{ id: string }> };
      const blokken = [...new Set(invoer.diensten.map((d) => d.blok_id).filter(Boolean))];
      const toewijzingen = invoer.diensten.map((d, i) => ({
        dienst_id: d.id,
        aios_id: invoer.aios[(d.blok_id ? blokken.indexOf(d.blok_id) : i) % invoer.aios.length].id,
      }));
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ status: 'HAALBAAR', toewijzingen, leeg: [], per_aios: [], tijd_seconden: 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.AIOS_SOLVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  w.planner = staff('PLANNER', 'AIOS');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosLeven-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosLeven-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  const aios = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: `aiosleven-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2096-01-01', geldig_tot: '2096-12-31' });
    insert('dienstrooster_person_access_link', { person_id: id, token_hash: `aiosleven-${n}-${tag}`, aangemaakt_op: now });
    return id;
  };
  w.x = aios('x');
  w.y = aios('y');
  w.start = Q.start_datum;
  w.eind = Q.eind_datum;
});

afterAll(async () => {
  process.env.AIOS_SOLVER_URL = bewaardeUrl;
  await new Promise((r) => server.close(r));
  deleteRowsAfter(snapshot);
});

/** A fresh quarter in concept for each run. */
function nieuwKwartaal(): string {
  db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id IN (SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?)').run(w.pool);
  db.prepare("UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE pool_id = ? AND verwijderd_op IS NULL").run(now, w.pool);
  const id = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `AiosLeven-${crypto.randomUUID().slice(0, 6)}`,
    start_datum: Q.start_datum,
    eind_datum: Q.eind_datum,
    deadline: '2096-05-01T17:00',
    status: 'CONCEPT',
    auto_herinneren: 0,
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(id, aiosShiftTypes(w.pool)!, Q.start_datum, Q.eind_datum))();
  return id;
}

type Stap = { naam: string; doe: (id: string) => Promise<Response> };
const vraag = (id: string, pad: string, method: string, body: unknown) =>
  new NextRequest(`http://localhost/api/aios/periode/${id}/${pad}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: staffCookie(w.planner) },
    body: JSON.stringify(body),
  });

const STAPPEN: Stap[] = [
  { naam: 'openen', doe: (id) => openen(vraag(id, 'openen', 'POST', { deadline: '2096-05-10T17:00' }), ctx(id)) },
  { naam: 'sluiten', doe: (id) => sluiten(vraag(id, 'sluiten', 'POST', {}), ctx(id)) },
  { naam: 'heropenen', doe: (id) => heropenen(vraag(id, 'heropenen', 'POST', {}), ctx(id)) },
  { naam: 'deadline', doe: (id) => deadline(vraag(id, 'deadline', 'PATCH', { deadline: '2096-05-20T17:00' }), ctx(id)) },
  {
    naam: 'genereren',
    doe: async (id) => {
      const res = await genereren(vraag(id, 'genereren', 'POST', {}), ctx(id));
      if (res.status === 202) {
        const job = (await res.clone().json()).data.job_id as string;
        for (let i = 0; i < 200 && aiosGeneratieJob(job, id)!.status === 'BEZIG'; i++) await new Promise((r) => setTimeout(r, 10));
        expect(aiosGeneratieJob(job, id)!.status).toBe('KLAAR');
      }
      return res;
    },
  },
  { naam: 'rooster-verwijderen', doe: (id) => roosterVerwijderen(vraag(id, 'rooster-verwijderen', 'POST', {}), ctx(id)) },
  { naam: 'publiceren', doe: (id) => publiceren(vraag(id, 'publiceren', 'POST', { bevestigd: true }), ctx(id)) },
  { naam: 'definitief', doe: (id) => definitief(vraag(id, 'definitief-maken', 'POST', { bevestigd: true }), ctx(id)) },
  { naam: 'intrekken', doe: (id) => intrekken(vraag(id, 'publicatie-intrekken', 'POST', {}), ctx(id)) },
  { naam: 'toets', doe: (id) => voortgangstoets(vraag(id, 'voortgangstoets', 'PUT', { datum: '2096-07-17' }), ctx(id)) },
  { naam: 'geen toets', doe: (id) => voortgangstoets(vraag(id, 'voortgangstoets', 'PUT', { datum: null }), ctx(id)) },
];

const nr = (naam: string) => STAPPEN.findIndex((s) => s.naam === naam);

/** Where each step may take the status, from where (the planner's flow). */
const MAG: Record<string, Record<string, string>> = {
  openen: { CONCEPT: 'OPEN' },
  sluiten: { OPEN: 'GESLOTEN' },
  heropenen: { GESLOTEN: 'OPEN' },
  deadline: { OPEN: 'OPEN' },
  genereren: { GESLOTEN: 'GEGENEREERD', GEGENEREERD: 'GEGENEREERD' },
  'rooster-verwijderen': { GEGENEREERD: 'GESLOTEN' },
  publiceren: { GEGENEREERD: 'GEPUBLICEERD' },
  definitief: { GEPUBLICEERD: 'GEPUBLICEERD' },
  intrekken: { GEPUBLICEERD: 'GEGENEREERD' },
};

const stand = (id: string) =>
  db
    .prepare('SELECT status, row_version, deadline, gepubliceerd_op, definitief_op FROM dienstrooster_schedule_period WHERE id = ?')
    .get(id) as { status: string; row_version: number; deadline: string; gepubliceerd_op: string | null; definitief_op: string | null };
const rooster = (id: string) =>
  JSON.stringify(db.prepare('SELECT slot_id, person_id FROM dienstrooster_assignment WHERE schedule_version_id = ? ORDER BY slot_id').all(id));
const diensten = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_shift_slot WHERE period_id = ?').get(id) as { n: number }).n;

describe('an AIOS quarter, any order of steps', () => {
  it('keeps its status, its roster and what the AIOS sees as the flow allows', async () => {
    await fc.assert(
      // A head start to a random status, then any steps.
      fc.asyncProperty(fc.nat(4), fc.array(fc.nat(STAPPEN.length - 1), { minLength: 3, maxLength: 12 }), async (ver, keuzes) => {
        const id = nieuwKwartaal();
        const aanloop = ['openen', 'sluiten', 'genereren', 'publiceren'].slice(0, ver).map(nr);
        for (const k of [...aanloop, ...keuzes]) {
          const stap = STAPPEN[k];
          const voor = stand(id);
          const voorRooster = rooster(id);
          const res = await stap.doe(id);
          const na = stand(id);
          const naam = `${stap.naam} vanuit ${voor.status}`;
          expect(res.status, naam).toBeLessThan(500);
          if (res.status >= 400) {
            // Refused: nothing changed.
            expect(na, naam).toEqual(voor);
            expect(rooster(id), naam).toBe(voorRooster);
          } else if (MAG[stap.naam]) {
            expect(MAG[stap.naam][voor.status], `${naam} mag niet`).toBeDefined();
            expect(na.status, naam).toBe(MAG[stap.naam][voor.status]);
          }
          if (na.status !== voor.status) expect(na.row_version, naam).toBeGreaterThan(voor.row_version);
          expect(na.row_version, naam).toBeGreaterThanOrEqual(voor.row_version);
          // A roster only once made, and then every dienst with one AIOS.
          const n = (JSON.parse(rooster(id)) as unknown[]).length;
          if (['CONCEPT', 'OPEN', 'GESLOTEN'].includes(na.status)) expect(n, naam).toBe(0);
          else expect(n, naam).toBe(diensten(id));
          expect(na.definitief_op === null || na.status === 'GEPUBLICEERD', naam).toBe(true);
          expect(na.gepubliceerd_op === null || na.status === 'GEPUBLICEERD', naam).toBe(true);
          const eigen = await eigenRooster(
            new NextRequest(`http://localhost/api/aios/deelnemer/${w.x}/periode/${id}/rooster`, { headers: { cookie: personCookie(w.x) } }),
            { params: Promise.resolve({ id: w.x, periodId: id }) }
          );
          expect(eigen.status, naam).toBe(na.status === 'GEPUBLICEERD' ? 200 : 404);
        }
      }),
      // Always this one too: the toets taken away from a roster already made gave its night back to nobody.
      { numRuns: 40, examples: [[2, ['toets', 'genereren', 'geen toets'].map(nr)]] }
    );
  }, 180_000);
});
