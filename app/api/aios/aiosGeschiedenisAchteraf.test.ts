import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosGeneratieJob } from '@/lib/aiosGenereren';
import { zetTerugzettenBezig } from '@/lib/terugzetBezig';
import { buildXlsx } from '../../../tests/fixtures/buildXlsx';
import { POST as genereren } from './periode/[id]/genereren/route';
import { POST as inlezen } from './periode/[id]/geschiedenis/route';
import { deleteRowsAfter, insert, now, rowidSnapshot, staff, staffCookie, tag } from '../../../tests/fixtures/dienstWorlds';

/**
 * The rule (1.1.1): the AIOS's history from before the app can be read in at
 * any time, also after the invitations, and it counts in the next roster
 * made - but never silently not:
 * - read in after the opening, the solver gets each AIOS's saldo from it;
 * - read in after a roster was made, the check and the save say that roster
 *   does not have it, and making it again does;
 * - a published roster: said that it does not change;
 * - while a roster of any quarter of the pool is being made, saving is
 *   refused and nothing is written (the history is the pool's, and that run
 *   read it when it started); checking a file still works.
 *
 * A fake AIOS solver records what the app sends. That the solver gives an
 * AIOS with a saldo that many points more or fewer is aios-solver's
 * test_eerlijkheid.py test_a_saldo_carries_over.
 */

let snapshot: Map<string, number>;
let server: http.Server;
const opgevangen: Array<Record<string, any>> = [];
let wacht: Promise<void> | null = null;
const bewaardeUrl = process.env.AIOS_SOLVER_URL;
const w = {} as { pool: string; a: string; b: string; planner: string; x: string; z: string };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (pad: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://localhost/api/aios/periode/${pad}`, {
    method,
    headers: { cookie: staffCookie(w.planner), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const zetStatus = (id: string, s: string) => db.prepare('UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?').run(s, id);
const naam = (p: 'A' | 'B') => `Achteraf-${p}-${tag}`;
const cn = (n: 'x' | 'z') => `achteraf-${n}-${tag}`;
const KOP = [
  'Codenaam',
  'Nachten',
  'Avonden door de week',
  'Avonden in het weekend',
  'Dagdiensten',
  'Uitloopdiensten',
  'Feestdagdiensten (ook bij de soort geteld)',
  'Fte',
  'Maanden',
];
/** x and z, nights only: points as nights, both twelve months, x at 0,5 fte. */
const bestand = (x: number, z: number) =>
  buildXlsx([KOP, [cn('x'), x, 0, 0, 0, 0, 0, '0,5', 12], [cn('z'), z, 0, 0, 0, 0, 0, 1, 12]]).toString('base64');

const beginstand = () =>
  db.prepare('SELECT person_id, nachten FROM dienstrooster_aios_beginstand WHERE pool_id = ? ORDER BY person_id').all(w.pool);

async function start(period: string): Promise<string> {
  zetStatus(period, 'GESLOTEN');
  const res = await genereren(req(`${period}/genereren`, 'POST', {}), ctx(period));
  expect(res.status).toBe(202);
  return (await res.json()).data.job_id as string;
}

async function klaar(period: string, jobId: string): Promise<void> {
  for (let i = 0; i < 400 && aiosGeneratieJob(jobId, period)!.status === 'BEZIG'; i++) await new Promise((r) => setTimeout(r, 20));
  expect(aiosGeneratieJob(jobId, period)!.status).toBe('KLAAR');
}

/** Makes the period's roster with the fake solver; what it was sent per AIOS. */
async function maak(period: string): Promise<Record<string, number>> {
  opgevangen.length = 0;
  await klaar(period, await start(period));
  return Object.fromEntries(opgevangen[0].aios.map((a: any) => [a.id === w.x ? 'x' : a.id === w.z ? 'z' : a.id, a.saldo_punten]));
}

beforeAll(async () => {
  snapshot = rowidSnapshot();
  w.planner = staff('PLANNER', 'AIOS');
  const ruleset = insert('dienstrooster_ruleset', { naam: `Achteraf-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `Achteraf-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  const periode = (p: 'A' | 'B', van: string, tot: string) => {
    const id = insert('dienstrooster_schedule_period', {
      pool_id: w.pool,
      naam: naam(p),
      start_datum: van,
      eind_datum: tot,
      deadline: '2095-05-01T17:00',
      status: 'OPEN',
      uitgenodigd_op: now,
      auto_herinneren: 0,
      aangemaakt_op: now,
    });
    db.transaction(() => persistAiosSlots(id, aiosShiftTypes(w.pool)!, van, tot))();
    return id;
  };
  // Two quarters of one pool, two weeks each; A's invitations are out.
  w.a = periode('A', '2095-07-06', '2095-07-19');
  w.b = periode('B', '2095-07-20', '2095-08-02');
  for (const n of ['x', 'z'] as const) {
    w[n] = insert('dienstrooster_person', { codenaam: cn(n), rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: w[n], pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
  }

  server = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => (body += c));
    rq.on('end', async () => {
      opgevangen.push(JSON.parse(body));
      if (wacht) await wacht;
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ status: 'HAALBAAR', toewijzingen: [], leeg: [], per_aios: [], tijd_seconden: 0.1 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.AIOS_SOLVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  process.env.AIOS_SOLVER_URL = bewaardeUrl;
  await new Promise((r) => server.close(r));
  deleteRowsAfter(snapshot);
});

describe('the history from before the app, read in after the opening', () => {
  it('counts in the roster made next: the solver gets each AIOS its saldo from it', async () => {
    // 30 nights over 18 fte-months: x's share 10 and did 20, z's share 20 and did 10.
    const check = (await (await inlezen(req(`${w.a}/geschiedenis`, 'POST', { bestand: bestand(20, 10), toepassen: false }), ctx(w.a))).json()).data.plan;
    expect(check.problemen).toEqual([]);
    expect(check.waarschuwingen).toEqual([]);
    const res = await inlezen(req(`${w.a}/geschiedenis`, 'POST', { bestand: bestand(20, 10), toepassen: true }), ctx(w.a));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ toegepast: true, plan: { waarschuwingen: [] } });

    expect(await maak(w.a)).toEqual({ x: -10, z: 10 });
  });

  it('after the roster was made: the check and the save say that roster does not have it, and making it again does', async () => {
    // A is GEGENEREERD now, without the new history below.
    const bericht = `Voor ${naam('A')} is al een rooster gemaakt. Wat je nu inleest, telt daarin pas mee als je dat rooster opnieuw maakt.`;
    const check = (await (await inlezen(req(`${w.a}/geschiedenis`, 'POST', { bestand: bestand(6, 24), toepassen: false }), ctx(w.a))).json()).data.plan;
    expect(check.waarschuwingen).toEqual([bericht]);
    // Also said from the other quarter's page: the history is the pool's.
    const vanB = (await (await inlezen(req(`${w.b}/geschiedenis`, 'POST', { bestand: bestand(6, 24), toepassen: false }), ctx(w.b))).json()).data.plan;
    expect(vanB.waarschuwingen).toEqual([bericht]);

    const opslaan = await inlezen(req(`${w.a}/geschiedenis`, 'POST', { bestand: bestand(6, 24), toepassen: true, bevestigd: true }), ctx(w.a));
    expect(opslaan.status).toBe(200);
    expect((await opslaan.json()).data.plan.waarschuwingen).toEqual([bericht]);

    // Made again, it counts: x's share 10 and did 6, z's 20 and did 24.
    expect(await maak(w.a)).toEqual({ x: 4, z: -4 });
  });

  it('a published roster: says it does not change', async () => {
    zetStatus(w.a, 'GEPUBLICEERD');
    try {
      const check = (await (await inlezen(req(`${w.a}/geschiedenis`, 'POST', { bestand: bestand(6, 24), toepassen: false }), ctx(w.a))).json()).data.plan;
      expect(check.waarschuwingen).toEqual([`Het rooster van ${naam('A')} is al gepubliceerd. Wat je nu inleest, verandert dat rooster niet.`]);
    } finally {
      zetStatus(w.a, 'GEGENEREERD');
    }
  });

  it('while a roster of any quarter of the pool is being made: saving is refused and nothing written, checking still works', async () => {
    const voor = beginstand();
    let los!: () => void;
    wacht = new Promise<void>((r) => (los = r));
    const jobB = await start(w.b);
    try {
      for (let i = 0; i < 200 && opgevangen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      // From A's page while B's roster is being made: the same pool.
      for (const vanaf of [w.a, w.b]) {
        const res = await inlezen(req(`${vanaf}/geschiedenis`, 'POST', { bestand: bestand(15, 15), toepassen: true, bevestigd: true }), ctx(vanaf));
        expect(res.status).toBe(409);
        const fout = (await res.json()).error;
        expect(fout.code).toBe('AIOS_GENERATIE_LOOPT');
        expect(fout.message).toBe('Er wordt een rooster voor deze periode gemaakt. Wacht tot dat klaar is en probeer het dan opnieuw.');
      }
      expect(beginstand()).toEqual(voor);
      const check = await inlezen(req(`${w.a}/geschiedenis`, 'POST', { bestand: bestand(15, 15), toepassen: false }), ctx(w.a));
      expect(check.status).toBe(200);
    } finally {
      los();
      wacht = null;
      await klaar(w.b, jobB);
    }
    // Done: saving works again.
    const res = await inlezen(req(`${w.a}/geschiedenis`, 'POST', { bestand: bestand(15, 15), toepassen: true, bevestigd: true }), ctx(w.a));
    expect(res.status).toBe(200);
  });

  // 1.1.1 (lib/terugzetBezig.ts): a roster written while a backup is restored would land in the restored database.
  it('no AIOS roster is made while a backup is being restored', async () => {
    zetStatus(w.b, 'GESLOTEN');
    zetTerugzettenBezig(true);
    try {
      opgevangen.length = 0;
      const res = await genereren(req(`${w.b}/genereren`, 'POST', {}), ctx(w.b));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toEqual({ code: 'TERUGZETTEN_BEZIG', message: 'Er wordt een back-up teruggezet. Wacht tot dat klaar is en probeer het dan opnieuw.' });
      expect(opgevangen).toHaveLength(0);
    } finally {
      zetTerugzettenBezig(false);
    }
  });
});
