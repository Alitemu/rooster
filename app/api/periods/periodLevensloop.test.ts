import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fc from 'fast-check';
import http from 'http';
import type { AddressInfo } from 'net';
import { db } from '@/db/client';
import { getRosterGenerationJob } from '@/lib/rosterGenerationJobs';
import { POST as openen } from './[id]/open/route';
import { POST as sluiten } from './[id]/close/route';
import { POST as heropenen } from './[id]/reopen/route';
import { PATCH as deadline } from './[id]/deadline/route';
import { POST as roosterVerwijderen } from './[id]/reset-roster/route';
import { POST as herstellen } from './[id]/restore/route';
import { DELETE as prullenbak } from './[id]/route';
import { POST as genereren } from '../planner/period/[id]/generate-roster/route';
import { POST as handmatig } from '../planner/period/[id]/assignments/manual-assign/route';
import { POST as publiceren } from '../planner/period/[id]/publish/route';
import { POST as intrekken } from '../planner/period/[id]/unpublish/route';
import { POST as definitief } from '../planner/period/[id]/finalize/route';
import { GET as eigenRooster } from '../person/[id]/roster/[period-id]/route';
import { PATCH as voorkeur } from '../person/[id]/preferences/slot/[slotId]/route';
import { deleteRowsAfter, insert, now, personCookie, rowidSnapshot, staff, staffCookie, tag } from '../../../tests/fixtures/dienstWorlds';

/**
 * The life of an achterwacht period, in any order the planner clicks (the
 * full audit, 0.86.0): open, close, back to open, move the deadline,
 * generate, remove the roster (with or without what was filled in by
 * hand), fill in by hand, publish, withdraw, make definitief, the
 * prullenbak and back; and a participant marking a day in between.
 * Whatever the order:
 * - no step answers 500;
 * - a refused step changes nothing: not the period, not the roster, not
 *   the marks;
 * - the steps go only where the status allows;
 * - before generating only rows filled in by hand, after it every dienst
 *   with someone (the stand-in solver fills them all);
 * - the version only goes up, with every change of status;
 * - a participant sees their roster only while it is published, and marks
 *   a day only while the period is open;
 * - in the prullenbak nothing goes through but coming back.
 * ./periodLifecycle.test.ts holds a model of the same flow with the
 * generating simulated; this one runs the real routes from concept on, the
 * solver's answer through generate-roster and the prullenbak included.
 */

let snapshot: Map<string, number>;
let server: http.Server;
const bewaardeUrl = process.env.SOLVER_URL;
const w = {} as { pool: string; planner: string; a: string; b: string };
const RULESET = { windowWeeks: 0, bandAvond: [0, 20], bandWeekend: [0, 20], bandFeestdag: [0, 20] };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  snapshot = rowidSnapshot();
  // The stand-in solver: the diensten in turn to A and B.
  server = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => (body += c));
    rq.on('end', () => {
      const slots = (JSON.parse(body) as { slots: Array<{ id: string }> }).slots;
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(
        JSON.stringify({
          success: true,
          assignments: slots.map((s, i) => ({ slot_id: s.id, person_id: i % 2 ? w.b : w.a })),
          diagnostics: { unfilled_slots: [], solver_status: 'OPTIMAL', total_cost: 0, violations: {}, time_seconds: 0 },
        })
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.SOLVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  w.planner = staff('PLANNER', 'ACHTERWACHT');
  const ruleset = insert('dienstrooster_ruleset', { naam: `Levensloop-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `Levensloop-${tag}`, ruleset_id: ruleset, aangemaakt_op: now });
  for (const teller of ['AVOND', 'WEEKEND', 'FEESTDAG']) insert('dienstrooster_shift_type', { pool_id: w.pool, naam: teller, teller });
  const lid = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: `levensloop-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2097-01-01', geldig_tot: '2097-12-31' });
    insert('dienstrooster_person_access_link', { person_id: id, token_hash: `levensloop-${n}-${tag}`, aangemaakt_op: now });
    return id;
  };
  w.a = lid('a');
  w.b = lid('b');
});

afterAll(async () => {
  process.env.SOLVER_URL = bewaardeUrl;
  await new Promise((r) => server.close(r));
  deleteRowsAfter(snapshot);
});

/** A fresh period in concept for each run; the ones before it in the prullenbak. */
function nieuwePeriode(): string {
  db.prepare("UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE pool_id = ? AND verwijderd_op IS NULL").run(now, w.pool);
  return insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `Levensloop-${crypto.randomUUID().slice(0, 6)}`,
    start_datum: '2097-03-04',
    eind_datum: '2097-03-17',
    deadline: '2097-02-20T17:00:00.000Z',
    status: 'CONCEPT',
    aangemaakt_op: now,
  });
}

const eersteDienst = (id: string) =>
  (db.prepare('SELECT id FROM dienstrooster_shift_slot WHERE period_id = ? ORDER BY datum, id LIMIT 1').get(id) as { id: string } | undefined)?.id;

type Stap = { naam: string; doe: (id: string) => Promise<Response> };
const vraag = (pad: string, method: string, body?: unknown, cookie = staffCookie(w.planner)) =>
  new NextRequest(`http://localhost/api/${pad}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const STAPPEN: Stap[] = [
  {
    naam: 'openen',
    doe: (id) =>
      openen(
        vraag(`periods/${id}/open`, 'POST', {
          naam: 'Levensloop',
          start_datum: '2097-03-04',
          eind_datum: '2097-03-17',
          deadline: '2097-02-20T17:00:00.000Z',
          ruleset: RULESET,
        }),
        ctx(id)
      ),
  },
  { naam: 'sluiten', doe: (id) => sluiten(vraag(`periods/${id}/close`, 'POST', {}), ctx(id)) },
  { naam: 'heropenen', doe: (id) => heropenen(vraag(`periods/${id}/reopen`, 'POST', {}), ctx(id)) },
  { naam: 'deadline', doe: (id) => deadline(vraag(`periods/${id}/deadline`, 'PATCH', { deadline: '2097-02-25T17:00:00.000Z' }), ctx(id)) },
  {
    naam: 'genereren',
    doe: async (id) => {
      const res = await genereren(vraag(`planner/period/${id}/generate-roster`, 'POST'), ctx(id));
      if (res.ok) {
        const job = (await res.clone().json()).data.job_id as string;
        for (let i = 0; i < 200 && getRosterGenerationJob(job, id)?.status === 'RUNNING'; i++) await new Promise((r) => setTimeout(r, 10));
        expect(getRosterGenerationJob(job, id)?.status).toBe('DONE');
      }
      return res;
    },
  },
  { naam: 'rooster-verwijderen', doe: (id) => roosterVerwijderen(vraag(`periods/${id}/reset-roster`, 'POST', {}), ctx(id)) },
  {
    naam: 'rooster-verwijderen-alles',
    doe: (id) => roosterVerwijderen(vraag(`periods/${id}/reset-roster`, 'POST', { ook_handmatig: true }), ctx(id)),
  },
  {
    naam: 'handmatig',
    doe: (id) =>
      handmatig(
        vraag(`planner/period/${id}/assignments/manual-assign`, 'POST', { person_id: w.a, slot_id: eersteDienst(id) ?? 'geen', reason: 'Levensloop' }),
        ctx(id)
      ),
  },
  { naam: 'publiceren', doe: (id) => publiceren(vraag(`planner/period/${id}/publish`, 'POST', { confirmOverrides: true }), ctx(id)) },
  { naam: 'intrekken', doe: (id) => intrekken(vraag(`planner/period/${id}/unpublish`, 'POST', {}), ctx(id)) },
  { naam: 'definitief', doe: (id) => definitief(vraag(`planner/period/${id}/finalize`, 'POST', { confirmOverrides: true }), ctx(id)) },
  { naam: 'prullenbak', doe: (id) => prullenbak(vraag(`periods/${id}`, 'DELETE'), ctx(id)) },
  { naam: 'herstellen', doe: (id) => herstellen(vraag(`periods/${id}/restore`, 'POST', {}), ctx(id)) },
  {
    naam: 'voorkeur',
    doe: (id) => {
      const slotId = eersteDienst(id) ?? 'geen';
      return voorkeur(vraag(`person/${w.a}/preferences/slot/${slotId}`, 'PATCH', { level: 'VOORKEUR' }, personCookie(w.a)), {
        params: Promise.resolve({ id: w.a, slotId }),
      });
    },
  },
];

/** Where each step may take the status, from where (the planner's flow). */
const MAG: Record<string, Record<string, string>> = {
  openen: { CONCEPT: 'OPEN' },
  sluiten: { OPEN: 'GESLOTEN' },
  heropenen: { GESLOTEN: 'OPEN', GEGENEREERD: 'OPEN' },
  deadline: { OPEN: 'OPEN' },
  genereren: { OPEN: 'GEGENEREERD', GESLOTEN: 'GEGENEREERD', GEGENEREERD: 'GEGENEREERD' },
  'rooster-verwijderen': { GEGENEREERD: 'GESLOTEN' },
  'rooster-verwijderen-alles': { GEGENEREERD: 'GESLOTEN' },
  handmatig: { OPEN: 'OPEN', GESLOTEN: 'GESLOTEN', GEGENEREERD: 'GEGENEREERD', GEPUBLICEERD: 'GEPUBLICEERD' },
  publiceren: { GEGENEREERD: 'GEPUBLICEERD' },
  intrekken: { GEPUBLICEERD: 'GEGENEREERD' },
  definitief: { GEPUBLICEERD: 'GEPUBLICEERD' },
  voorkeur: { OPEN: 'OPEN' },
};

const stand = (id: string) =>
  db
    .prepare('SELECT status, row_version, deadline, gepubliceerd_op, definitief_op, verwijderd_op FROM dienstrooster_schedule_period WHERE id = ?')
    .get(id) as { status: string; row_version: number; deadline: string; gepubliceerd_op: string | null; definitief_op: string | null; verwijderd_op: string | null };
const rooster = (id: string) =>
  db.prepare('SELECT slot_id, person_id, bron FROM dienstrooster_assignment WHERE schedule_version_id = ? ORDER BY slot_id').all(id) as Array<{
    slot_id: string;
    person_id: string;
    bron: string;
  }>;
const markeringen = (id: string) =>
  JSON.stringify(
    db
      .prepare('SELECT a.person_id, a.slot_id, a.blocking_level FROM dienstrooster_availability a JOIN dienstrooster_shift_slot s ON s.id = a.slot_id WHERE s.period_id = ? ORDER BY a.slot_id')
      .all(id)
  );
const diensten = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_shift_slot WHERE period_id = ?').get(id) as { n: number }).n;

describe('an achterwacht period, any order of steps', () => {
  it('keeps its status, its roster and what a participant sees as the flow allows', async () => {
    await fc.assert(
      // A head start to a random status, then any steps.
      fc.asyncProperty(fc.nat(4), fc.array(fc.nat(STAPPEN.length - 1), { minLength: 3, maxLength: 12 }), async (ver, keuzes) => {
        const id = nieuwePeriode();
        const aanloop = ['openen', 'sluiten', 'genereren', 'publiceren'].slice(0, ver).map((n) => STAPPEN.findIndex((s) => s.naam === n));
        for (const k of [...aanloop, ...keuzes]) {
          const stap = STAPPEN[k];
          const voor = stand(id);
          const voorRooster = JSON.stringify(rooster(id));
          const voorMarkeringen = markeringen(id);
          const res = await stap.doe(id);
          const na = stand(id);
          const naam = `${stap.naam} vanuit ${voor.status}${voor.verwijderd_op ? ' (prullenbak)' : ''}`;
          expect(res.status, naam).toBeLessThan(500);
          // In the prullenbak only coming back goes through (lib/periodTrash.ts).
          if (voor.verwijderd_op && stap.naam !== 'herstellen') expect(res.status, naam).toBeGreaterThanOrEqual(400);
          if (res.status >= 400) {
            // Refused: nothing changed.
            expect(na, naam).toEqual(voor);
            expect(JSON.stringify(rooster(id)), naam).toBe(voorRooster);
            expect(markeringen(id), naam).toBe(voorMarkeringen);
          } else if (MAG[stap.naam]) {
            expect(MAG[stap.naam][voor.status], `${naam} mag niet`).toBeDefined();
            expect(na.status, naam).toBe(MAG[stap.naam][voor.status]);
          }
          if (na.status !== voor.status) expect(na.row_version, naam).toBeGreaterThan(voor.row_version);
          expect(na.row_version, naam).toBeGreaterThanOrEqual(voor.row_version);
          // Before generating only what was filled in by hand, after it every dienst with someone.
          const rij = rooster(id);
          if (na.status === 'CONCEPT') expect(rij.length + diensten(id), naam).toBe(0);
          else if (['OPEN', 'GESLOTEN'].includes(na.status)) expect(rij.filter((r) => r.bron === 'SOLVER'), naam).toEqual([]);
          else expect(rij.length, naam).toBe(diensten(id));
          expect(na.definitief_op === null || na.status === 'GEPUBLICEERD', naam).toBe(true);
          expect(na.gepubliceerd_op === null || na.status === 'GEPUBLICEERD', naam).toBe(true);
          const eigen = await eigenRooster(vraag(`person/${w.a}/roster/${id}`, 'GET', undefined, personCookie(w.a)), {
            params: Promise.resolve({ id: w.a, 'period-id': id }),
          });
          expect(eigen.status, naam).toBe(na.verwijderd_op ? 404 : na.status === 'GEPUBLICEERD' ? 200 : 403);
        }
      }),
      { numRuns: 40 }
    );
  }, 180_000);
});
