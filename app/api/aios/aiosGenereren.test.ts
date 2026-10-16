import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { syncAiosPeriode } from '@/lib/aiosSync';
import { blokkadeTellers, loadAiosPeriode, loadAiosVoorkeurDagen, saveAiosWens, setAiosVoorkeur } from '@/lib/aiosPreferences';
import { aiosGeneratieJob } from '@/lib/aiosGenereren';
import { aiosFeestdagVragen, bewaarAiosFeestdagKeuzes } from '@/lib/aiosFeestdagBlokken';
import { POST as genereren } from './periode/[id]/genereren/route';
import { GET as status } from './periode/[id]/genereren/status/route';
import { GET as rooster } from './periode/[id]/rooster/route';
import { POST as verwijderen } from './periode/[id]/rooster-verwijderen/route';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, staff, staffCookie, tag, type World } from '../../../tests/fixtures/dienstWorlds';

/**
 * The rules of making an AIOS roster from the app (lib/aiosGenereren.ts,
 * lib/aiosSolverInvoer.ts), against a fake AIOS-solver that records what
 * the app sends (the real one is aios-solver/, with its own tests):
 * - only a gesloten (or already gegenereerd) period, one generation at a time;
 * - the request is the contract: every dienst and block, every AIOS taking
 *   part with the fte from their part-time days, those days, inwerken, the
 *   marks with where they came from, and per counter the part above half the
 *   AIOS's screen promised;
 * - what the solver answers is written and the period is gegenereerd; an
 *   error, or a period changed meanwhile, writes nothing;
 * - making it again replaces the roster; "Rooster verwijderen" empties it;
 * - the roster shows who has what and each AIOS's dienstpercentage;
 * - all of it the AIOS's planner's, not the achterwacht's.
 */

let snapshot: Map<string, number>;
let staf: World;
let server: http.Server;
const opgevangen: Array<Record<string, any>> = [];
let antwoordVan: (invoer: Record<string, any>) => { status: number; body: unknown; vertraging?: number };
const bewaardeUrl = process.env.AIOS_SOLVER_URL;
const w = {} as { pool: string; period: string; planner: string; x: string; y: string; open: string };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (pad: string, cookie: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://localhost/api/aios/periode/${pad}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const slotsVan = (periodId: string) =>
  db
    .prepare(
      `SELECT sl.id, sl.datum, st.code, st.punten, sl.shift_block_id AS blok FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id WHERE sl.period_id = ? ORDER BY sl.datum, st.start_tijd`
    )
    .all(periodId) as Array<{ id: string; datum: string; code: string; punten: number; blok: string | null }>;

const toewijzingen = () =>
  db.prepare('SELECT slot_id, person_id, bron FROM dienstrooster_assignment WHERE schedule_version_id = ? ORDER BY slot_id').all(w.period) as Array<{
    slot_id: string;
    person_id: string;
    bron: string;
  }>;

const periodeStatus = () =>
  db.prepare('SELECT status, row_version FROM dienstrooster_schedule_period WHERE id = ?').get(w.period) as { status: string; row_version: number };

async function klaar(jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = aiosGeneratieJob(jobId, w.period)!;
    if (job.status !== 'BEZIG') return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('generation did not finish');
}

async function maak(tijdslimiet?: number) {
  const res = await genereren(req(`${w.period}/genereren`, staffCookie(w.planner), 'POST', tijdslimiet ? { tijdslimiet_seconden: tijdslimiet } : {}), ctx(w.period));
  expect(res.status).toBe(202);
  return (await res.json()).data.job_id as string;
}

/** The fake solver's usual answer: the first night block to x, the Saturday dagdiensten to y, one UD empty. */
function gewoon(invoer: Record<string, any>) {
  const nacht = invoer.blokken.find((b: any) => b.soort === 'NACHT' && b.vorm === 'ZO_DI').id;
  const toew = invoer.diensten
    .filter((d: any) => d.blok_id === nacht)
    .map((d: any) => ({ dienst_id: d.id, aios_id: w.x }))
    .concat(invoer.diensten.filter((d: any) => d.code === 'DD' && new Date(`${d.datum}T12:00:00`).getDay() === 6).map((d: any) => ({ dienst_id: d.id, aios_id: w.y })));
  const ud = invoer.diensten.find((d: any) => d.code === 'UD');
  return { status: 200, body: { status: 'HAALBAAR', toewijzingen: toew, leeg: [{ dienst_id: ud.id, redenen: { GEBLOKKEERD: 1, BEZET: 1 } }], per_aios: [], tijd_seconden: 1.2 } };
}

beforeAll(async () => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosGen-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosGen-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  // 2096 Q2: Pasen, Koningsdag and Hemelvaart in it.
  const q = aiosQuarter(2096, 2);
  const periode = (status: string, naam: string) =>
    insert('dienstrooster_schedule_period', {
      pool_id: w.pool,
      naam,
      start_datum: q.start_datum,
      eind_datum: q.eind_datum,
      deadline: '2096-02-10T17:00',
      status,
      auto_herinneren: 0,
      aangemaakt_op: now,
    });
  w.period = periode('OPEN', `AiosGen-${tag}`);
  db.transaction(() => persistAiosSlots(w.period, aiosShiftTypes(w.pool)!, q.start_datum, q.eind_datum))();
  const deelnemer = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: `aiosgen-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
  // x: a part-time Monday every week, a week of leave, inwerken, the Saturday nights blocked by hand.
  insert('dienstrooster_parttime_pattern', { person_id: w.x, weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31', aangemaakt_door: w.x, aangemaakt_op: now });
  insert('dienstrooster_absence', { person_id: w.x, van_datum: '2096-05-04', tot_datum: '2096-05-08', soort: 'VAKANTIE', aangemaakt_door: w.x, aangemaakt_op: now });
  syncAiosPeriode(w.period);
  const p = loadAiosPeriode(w.period)!;
  expect(saveAiosWens(w.x, p, { inwerken_van: q.start_datum, inwerken_tot: '2096-04-14', vier_nachten: true })).toEqual({ ok: true });
  const zaterdagNachten = db
    .prepare(
      `SELECT MIN(s.id) AS slot FROM dienstrooster_shift_block b JOIN dienstrooster_shift_slot s ON s.shift_block_id = b.id
       WHERE b.period_id = ? AND b.soort = 'NACHT' AND b.vorm = 'ZA'
         AND NOT EXISTS (SELECT 1 FROM dienstrooster_shift_slot f WHERE f.shift_block_id = b.id AND f.is_feestdag = 1)
       GROUP BY b.id`
    )
    .all(w.period) as Array<{ slot: string }>;
  for (const z of zaterdagNachten) expect(setAiosVoorkeur(w.x, w.period, z.slot, 'ABSOLUUT')).toEqual({ ok: true });
  db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GESLOTEN' WHERE id = ?`).run(w.period);
  // Pasen and Pinksteren: every block whole (aiosFeestdagBlokken.test.ts asks and cuts them).
  const vragen = aiosFeestdagVragen(p);
  const heel = vragen.groepen.flatMap((g) => g.blokken).map((b) => ({ blok_id: b.blok_id, keuze: 'HEEL' }));
  expect(bewaarAiosFeestdagKeuzes(p, heel, undefined)).toEqual({ ok: true });
  w.open = periode('OPEN', `AiosGen-open-${tag}`);

  server = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => (body += c));
    rq.on('end', () => {
      const invoer = JSON.parse(body);
      opgevangen.push(invoer);
      const a = antwoordVan(invoer);
      setTimeout(() => {
        rs.writeHead(a.status, { 'content-type': 'application/json' });
        rs.end(JSON.stringify(a.body));
      }, a.vertraging ?? 0);
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

beforeEach(() => {
  opgevangen.length = 0;
  antwoordVan = gewoon;
});

describe('making the AIOS roster', () => {
  it('only from a closed period, at a time limit on offer', async () => {
    const open = await genereren(req(`${w.open}/genereren`, staffCookie(w.planner), 'POST', {}), ctx(w.open));
    expect(open.status).toBe(409);
    expect((await open.json()).error.message).toMatch(/Sluit eerst de periode/);
    const vreemd = await genereren(req(`${w.period}/genereren`, staffCookie(w.planner), 'POST', { tijdslimiet_seconden: 45 }), ctx(w.period));
    expect(vreemd.status).toBe(400);
    expect(opgevangen).toHaveLength(0);
  });

  it('sends the quarter as the contract says', async () => {
    await klaar(await maak(120));
    expect(opgevangen).toHaveLength(1);
    const invoer = opgevangen[0];
    expect(invoer.tijdslimiet_seconden).toBe(120);
    expect(invoer.diensten.map((d: any) => d.id).sort()).toEqual(slotsVan(w.period).map((s) => s.id).sort());
    expect(invoer.diensten.every((d: any) => /^\d{2}:\d{2}$/.test(d.start_tijd) && d.punten > 0 && 'blok_id' in d)).toBe(true);
    expect(invoer.blokken.length).toBe((db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_shift_block WHERE period_id = ?').get(w.period) as { n: number }).n);
    // A week either side: Koningsdag and Hemelvaart in, and nothing far away.
    expect(invoer.feestdagen).toEqual(expect.arrayContaining(['2096-04-27', '2096-05-24']));
    expect(invoer.aios.map((a: any) => a.id).sort()).toEqual([w.x, w.y].sort());

    const x = invoer.aios.find((a: any) => a.id === w.x);
    const y = invoer.aios.find((a: any) => a.id === w.y);
    expect(x.fte).toBe(0.8);
    expect(y.fte).toBe(1);
    expect(x.parttime_dagen.length).toBe(13);
    expect(x.parttime_dagen.every((d: string) => new Date(`${d}T12:00:00`).getDay() === 1)).toBe(true);
    expect(x.inwerken).toEqual({ van: invoer.periode.van, tot: '2096-04-14' });
    expect(x.vier_nachten).toBe(true);
    expect(x.beschikbaar).toEqual([invoer.periode]);
    const bronnen = new Set(x.markeringen.map((m: any) => m.bron));
    expect(bronnen).toEqual(new Set(['MANUAL', 'PARTTIME', 'ABSENCE']));
    // The part above half the AIOS's screen promised.
    const tellers = blokkadeTellers(loadAiosVoorkeurDagen(w.x, w.period));
    expect(x.erboven).toEqual(Object.fromEntries(tellers.filter((t) => t.erboven > 0).map((t) => [t.groep, t.erboven])));
    expect(x.erboven.ZATERDAG_NACHT).toBeGreaterThan(0);
  });

  it('writes what the solver answers and marks the period gegenereerd', async () => {
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GESLOTEN' WHERE id = ?`).run(w.period);
    const job = await klaar(await maak());
    expect(job.status).toBe('KLAAR');
    expect(job.uitkomst!.leeg).toEqual([expect.objectContaining({ code: 'UD', redenen: { GEBLOKKEERD: 1, BEZET: 1 } })]);
    expect(periodeStatus().status).toBe('GEGENEREERD');
    const t = toewijzingen();
    expect(t.length).toBe(gewoon(opgevangen[0]).body.toewijzingen.length);
    expect(t.every((r) => r.bron === 'SOLVER')).toBe(true);

    const res = await status(req(`${w.period}/genereren/status?job_id=${job.id}`, staffCookie(w.planner)), ctx(w.period));
    expect((await res.json()).data).toMatchObject({ status: 'KLAAR', fout: null });
  });

  it('shows who has what, and each AIOS their points and dienstpercentage', async () => {
    const res = await rooster(req(`${w.period}/rooster`, staffCookie(w.planner)), ctx(w.period));
    const data = (await res.json()).data;
    const x = data.per_aios.find((a: any) => a.person_id === w.x);
    const mijn = slotsVan(w.period).filter((s) => toewijzingen().some((t) => t.slot_id === s.id && t.person_id === w.x));
    expect(x.punten).toBeCloseTo(mijn.reduce((som, s) => som + s.punten, 0));
    expect(x.dienstpercentage).toBeCloseTo(x.punten / (x.werkdagen * 0.8));
    expect(x.nachten).toBe(3);
    const dienst = data.dagen.flatMap((d: any) => d.diensten).find((d: any) => d.slot_id === mijn[0].id);
    expect(dienst.aios.codenaam).toBe(`aiosgen-x-${tag}`);
    expect(data.leeg).toBe(slotsVan(w.period).length - toewijzingen().length);
  });

  it('one generation at a time, and the roster stays as it is meanwhile', async () => {
    antwoordVan = (i) => ({ ...gewoon(i), vertraging: 300 });
    const job = await maak();
    const tweede = await genereren(req(`${w.period}/genereren`, staffCookie(w.planner), 'POST', {}), ctx(w.period));
    expect(tweede.status).toBe(409);
    expect((await tweede.json()).error.code).toBe('GENERATION_RUNNING');
    const weg = await verwijderen(req(`${w.period}/rooster-verwijderen`, staffCookie(w.planner), 'POST'), ctx(w.period));
    expect(weg.status).toBe(409);
    await klaar(job);
  });

  it('making it again replaces the whole roster', async () => {
    const voor = toewijzingen();
    antwoordVan = (i) => {
      const g = gewoon(i);
      return { ...g, body: { ...(g.body as any), toewijzingen: (g.body as any).toewijzingen.map((t: any) => ({ ...t, aios_id: t.aios_id === w.x ? w.y : w.x })) } };
    };
    await klaar(await maak());
    const na = toewijzingen();
    expect(na.map((r) => r.slot_id)).toEqual(voor.map((r) => r.slot_id));
    expect(na.every((r, i) => r.person_id !== voor[i].person_id)).toBe(true);
  });

  it('writes nothing when the solver fails or the period changed meanwhile', async () => {
    const voor = toewijzingen();
    const rv = periodeStatus().row_version;
    antwoordVan = () => ({ status: 500, body: { detail: 'kapot' } });
    let job = await klaar(await maak());
    expect(job.status).toBe('FOUT');
    expect(job.fout).toMatch(/kon geen rooster maken/);
    expect(toewijzingen()).toEqual(voor);
    expect(periodeStatus().row_version).toBe(rv);

    antwoordVan = (i) => ({ ...gewoon(i), vertraging: 200 });
    const id = await maak();
    db.prepare('UPDATE dienstrooster_schedule_period SET row_version = row_version + 1 WHERE id = ?').run(w.period);
    job = await klaar(id);
    expect(job.status).toBe('FOUT');
    expect(job.fout).toMatch(/intussen gewijzigd/);
    expect(toewijzingen()).toEqual(voor);
  });

  it('"Rooster verwijderen" empties it and takes the period back to gesloten, once', async () => {
    const res = await verwijderen(req(`${w.period}/rooster-verwijderen`, staffCookie(w.planner), 'POST'), ctx(w.period));
    expect(res.status).toBe(200);
    expect(toewijzingen()).toEqual([]);
    expect(periodeStatus().status).toBe('GESLOTEN');
    const nogEens = await verwijderen(req(`${w.period}/rooster-verwijderen`, staffCookie(w.planner), 'POST'), ctx(w.period));
    expect(nogEens.status).toBe(409);
  });

  it("is the AIOS's planner's: the achterwacht's planner gets nothing, nor an achterwacht period", async () => {
    const stafCookie = staffCookie(staf.planner);
    expect((await genereren(req(`${w.period}/genereren`, stafCookie, 'POST', {}), ctx(w.period))).status).toBe(404);
    expect((await rooster(req(`${w.period}/rooster`, stafCookie), ctx(w.period))).status).toBe(404);
    expect((await verwijderen(req(`${w.period}/rooster-verwijderen`, stafCookie, 'POST'), ctx(w.period))).status).toBe(404);
    expect((await genereren(req(`${staf.period}/genereren`, staffCookie(w.planner), 'POST', {}), ctx(staf.period))).status).toBe(404);
    expect(opgevangen).toHaveLength(0);
  });
});
