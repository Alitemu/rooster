import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosGeneratieJob } from '@/lib/aiosGenereren';
import { laadAiosRooster } from '@/lib/aiosRooster';
import { aiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { aiosSaldi } from '@/lib/aiosSaldo';
import { readFirstSheet } from '@/lib/xlsx';
import { buildXlsx } from '../../../tests/fixtures/buildXlsx';
import { POST as genereren } from './periode/[id]/genereren/route';
import { POST as verwijderen } from './periode/[id]/rooster-verwijderen/route';
import { GET as geschiedenis, POST as inlezen } from './periode/[id]/geschiedenis/route';
import { GET as sjabloon } from './periode/[id]/geschiedenis-sjabloon/route';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, staff, staffCookie, tag, type World } from '../../../tests/fixtures/dienstWorlds';

/**
 * What an AIOS carries into a quarter (lib/aiosSaldo.ts, step 4e):
 * - after a published quarter: the solver's share there minus what they
 *   did, as the roster is now (a change by hand since counts), points and
 *   feestdagdiensten; an unpublished quarter doesn't count;
 * - before that: the history read in (lib/aiosGeschiedenis.ts), against the
 *   average per fte x maanden; otherwise nothing;
 * - a generation keeps the solver's share per AIOS, "Rooster verwijderen"
 *   takes it away;
 * - the history: a template with every AIOS of the pool, a file first
 *   checked (every problem, nothing saved), then saved, replacing what was;
 * - the AIOS's planner's only.
 */

let snapshot: Map<string, number>;
let staf: World;
let server: http.Server;
const opgevangen: Array<Record<string, any>> = [];
let perAios: (invoer: Record<string, any>) => Array<Record<string, unknown>> = () => [];
const bewaardeUrl = process.env.AIOS_SOLVER_URL;
const w = {} as { pool: string; a: string; b: string; planner: string; x: string; y: string; z: string };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (pad: string, method = 'GET', body?: unknown, cookie = staffCookie(w.planner)) =>
  new NextRequest(`http://localhost/api/aios/periode/${pad}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const zetStatus = (id: string, s: string) => db.prepare('UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?').run(s, id);
const nachten = (period: string) =>
  db
    .prepare(
      `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND st.code = 'ND' ORDER BY sl.datum`
    )
    .all(period) as Array<{ id: string }>;

/** Makes B's roster with the fake solver and gives back what it was sent per AIOS. */
async function maakB(): Promise<Map<string, { saldo_punten: number; feestdag_achterstand: number }>> {
  zetStatus(w.b, 'GESLOTEN');
  opgevangen.length = 0;
  const res = await genereren(req(`${w.b}/genereren`, 'POST', {}), ctx(w.b));
  expect(res.status).toBe(202);
  const jobId = (await res.json()).data.job_id as string;
  for (let i = 0; i < 200 && aiosGeneratieJob(jobId, w.b)!.status === 'BEZIG'; i++) await new Promise((r) => setTimeout(r, 20));
  expect(aiosGeneratieJob(jobId, w.b)!.status).toBe('KLAAR');
  return new Map(opgevangen[0].aios.map((a: any) => [a.id, { saldo_punten: a.saldo_punten, feestdag_achterstand: a.feestdag_achterstand }]));
}

const bestand = (rows: Array<Array<string | number | null>>) => buildXlsx(rows).toString('base64');
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
const cn = (n: 'x' | 'y' | 'z') => `aiossaldo-${n}-${tag}`;

beforeAll(async () => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosSaldo-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosSaldo-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  // Two quarters in a row, two weeks each, no feestdagen near.
  const periode = (naam: string, van: string, tot: string, status: string) => {
    const id = insert('dienstrooster_schedule_period', {
      pool_id: w.pool,
      naam: `AiosSaldo-${naam}-${tag}`,
      start_datum: van,
      eind_datum: tot,
      deadline: '2094-05-01T17:00',
      status,
      auto_herinneren: 0,
      aangemaakt_op: now,
    });
    db.transaction(() => persistAiosSlots(id, aiosShiftTypes(w.pool)!, van, tot))();
    return id;
  };
  w.a = periode('A', '2094-07-07', '2094-07-20', 'GEPUBLICEERD');
  w.b = periode('B', '2094-07-21', '2094-08-03', 'GESLOTEN');
  const deelnemer = (n: 'x' | 'y' | 'z') => {
    const id = insert('dienstrooster_person', { codenaam: cn(n), rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
  w.z = deelnemer('z');
  // A: x and y three nights each; their shares there 4 and 2 points, x 0,6 feestdagdienst.
  const n = nachten(w.a);
  n.slice(0, 3).forEach((s) => insert('dienstrooster_assignment', { schedule_version_id: w.a, person_id: w.x, slot_id: s.id, bron: 'SOLVER', row_version: 1, aangemaakt_op: now }));
  n.slice(3, 6).forEach((s) => insert('dienstrooster_assignment', { schedule_version_id: w.a, person_id: w.y, slot_id: s.id, bron: 'SOLVER', row_version: 1, aangemaakt_op: now }));
  insert('dienstrooster_aios_doel', { period_id: w.a, person_id: w.x, doel_punten: 4, doel_feestdagen: 0.6 });
  insert('dienstrooster_aios_doel', { period_id: w.a, person_id: w.y, doel_punten: 2, doel_feestdagen: 0 });

  server = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => (body += c));
    rq.on('end', () => {
      const invoer = JSON.parse(body);
      opgevangen.push(invoer);
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ status: 'HAALBAAR', toewijzingen: [], leeg: [], per_aios: perAios(invoer), tijd_seconden: 0.1 }));
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
  perAios = () => [];
});

describe('after a published quarter', () => {
  it('its share minus what they did, points and feestdagdiensten', async () => {
    const s = await maakB();
    expect(s.get(w.x)).toEqual({ saldo_punten: 1, feestdag_achterstand: 0.6 });
    expect(s.get(w.y)).toEqual({ saldo_punten: -1, feestdag_achterstand: 0 });
    // z had no share in A, and nothing read in.
    expect(s.get(w.z)).toEqual({ saldo_punten: 0, feestdag_achterstand: 0 });
  });

  it('as the roster is now: a change by hand since counts', async () => {
    const vierde = nachten(w.a)[3].id;
    db.prepare('UPDATE dienstrooster_assignment SET person_id = ? WHERE slot_id = ?').run(w.x, vierde);
    try {
      const s = await maakB();
      expect(s.get(w.x)!.saldo_punten).toBe(0);
      expect(s.get(w.y)!.saldo_punten).toBe(0);
    } finally {
      db.prepare('UPDATE dienstrooster_assignment SET person_id = ? WHERE slot_id = ?').run(w.y, vierde);
    }
  });

  it('a quarter not published does not count', async () => {
    zetStatus(w.a, 'GEGENEREERD');
    try {
      const s = await maakB();
      expect(s.get(w.x)).toEqual({ saldo_punten: 0, feestdag_achterstand: 0 });
    } finally {
      zetStatus(w.a, 'GEPUBLICEERD');
    }
  });

  it('the roster says it in words, and from where', () => {
    const rooster = laadAiosRooster(aiosUitnodigPeriode(w.b)!);
    const x = rooster.per_aios.find((a) => a.person_id === w.x)!;
    expect(x).toMatchObject({ saldo: '1 punt extra en 0,6 feestdagdiensten extra', saldo_bron: 'VORIG_KWARTAAL' });
    expect(rooster.per_aios.find((a) => a.person_id === w.y)!.saldo).toBe('1 punt minder');
  });
});

describe("the solver's share", () => {
  it('kept with the roster, gone with it', async () => {
    perAios = (invoer) => invoer.aios.map((a: any, i: number) => ({ aios_id: a.id, doel_punten: 3 + i, doel_feestdagdiensten: 0.5 }));
    await maakB();
    const doel = () => db.prepare('SELECT person_id, doel_punten FROM dienstrooster_aios_doel WHERE period_id = ? ORDER BY doel_punten').all(w.b);
    expect(doel()).toHaveLength(3);
    expect(laadAiosRooster(aiosUitnodigPeriode(w.b)!).per_aios.every((a) => a.doel_punten !== null)).toBe(true);
    // Made again: replaced, not added.
    await maakB();
    expect(doel()).toHaveLength(3);
    expect((await verwijderen(req(`${w.b}/rooster-verwijderen`, 'POST'), ctx(w.b))).status).toBe(200);
    expect(doel()).toHaveLength(0);
  });
});

describe('the history from before the app', () => {
  it('the template has every AIOS of the pool', async () => {
    const res = await sjabloon(req(`${w.b}/geschiedenis-sjabloon`), ctx(w.b));
    expect(res.status).toBe(200);
    const [kop, ...rijen] = readFirstSheet(Buffer.from(await res.arrayBuffer()));
    expect(kop).toEqual(KOP);
    expect(rijen.map((r) => r[0]).sort()).toEqual([cn('x'), cn('y'), cn('z')].sort());
  });

  it('a file with problems: every one of them, and nothing saved', async () => {
    const fout = bestand([
      KOP,
      [cn('x'), 10, 0, 0, 0, 0, 1, 1.5, 12],
      ['niemand', 1, 0, 0, 0, 0, 0, 1, 12],
      [cn('y'), -2, 0, 0, 0, 0, 0, 1, 12],
      [cn('z'), 5, 0, 0, 0, 0, 0, 1, 0],
      [cn('z'), 5, 0, 0, 0, 0, 0, 1, 12],
    ]);
    // A feestdagdienst is also counted at its soort: never more of them than diensten.
    const teVeel = bestand([KOP, [cn('x'), 2, 1, 0, 0, 0, 4, 1, 12], [cn('y'), 2, 1, 0, 0, 0, 3, 1, 12]]);
    const feest = (await (await inlezen(req(`${w.b}/geschiedenis`, 'POST', { bestand: teVeel, toepassen: false }), ctx(w.b))).json()).data.plan;
    expect(feest.problemen).toEqual(['Rij 2, Feestdagdiensten: hoogstens zoveel als de diensten samen, want een feestdagdienst is ook bij zijn soort geteld.']);
    expect(feest.rijen.map((r: { codenaam: string }) => r.codenaam)).toEqual([cn('y')]);
    const check = await inlezen(req(`${w.b}/geschiedenis`, 'POST', { bestand: fout, toepassen: false }), ctx(w.b));
    expect(check.status).toBe(200);
    const problemen = (await check.json()).data.plan.problemen as string[];
    expect(problemen).toEqual([
      'Rij 2, Fte: vul een getal in groter dan 0 en hoogstens 1, zoals 0,8.',
      'Rij 3: "niemand" is geen AIOS van deze pool.',
      'Rij 4, Nachten: vul een heel aantal in, 0 of meer.',
      'Rij 5, Maanden: vul het aantal maanden in waar de aantallen over gaan, hoogstens 240.',
      `Rij 6: ${cn('z')} staat er twee keer in.`,
    ]);
    const opslaan = await inlezen(req(`${w.b}/geschiedenis`, 'POST', { bestand: fout, toepassen: true }), ctx(w.b));
    expect(opslaan.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_aios_beginstand WHERE pool_id = ?').get(w.pool)).toEqual({ n: 0 });
    const kolommen = await inlezen(req(`${w.b}/geschiedenis`, 'POST', { bestand: bestand([['Naam', 'Nachten']]), toepassen: false }), ctx(w.b));
    expect((await kolommen.json()).data.plan.problemen[0]).toMatch(/^De kolommen kloppen niet/);
  });

  it('checked, then saved: per AIOS in words what it means', async () => {
    // x did 20 points at 0,5 fte, z 10 at 1,0 fte, both 12 months: x did more than their share.
    const goed = bestand([KOP, [cn('x'), 20, 0, 0, 0, 0, 2, '0,5', 12], [cn('z'), 10, 0, 0, 0, 0, 0, 1, 12], [cn('y'), null, null, null, null, null, null, null, null]]);
    const check = await (await inlezen(req(`${w.b}/geschiedenis`, 'POST', { bestand: goed, toepassen: false }), ctx(w.b))).json();
    expect(check.data.toegepast).toBe(false);
    expect(check.data.plan.problemen).toEqual([]);
    const gevolg = Object.fromEntries(check.data.plan.rijen.map((r: any) => [r.codenaam, r.gevolg]));
    expect(gevolg).toEqual({
      [cn('x')]: '10 punten minder en 1,3 feestdagdiensten minder',
      [cn('z')]: '10 punten extra en 1,3 feestdagdiensten extra',
    });
    const res = await inlezen(req(`${w.b}/geschiedenis`, 'POST', { bestand: goed, toepassen: true }), ctx(w.b));
    expect(res.status).toBe(200);
    const stand = (await (await geschiedenis(req(`${w.b}/geschiedenis`), ctx(w.b))).json()).data;
    expect(stand.rijen.map((r: any) => r.codenaam)).toEqual([cn('x'), cn('z')]);
    const audit = db.prepare(`SELECT COUNT(*) AS n FROM dienstrooster_audit_log WHERE entiteit_id = ? AND nieuw_json LIKE '%van voor de app%'`).get(w.pool);
    expect(audit).toEqual({ n: 1 });
  });

  it('counts for whoever has no published quarter before, not for whoever has', async () => {
    const s = await maakB();
    // x had a share in A: that counts, not the history.
    expect(s.get(w.x)).toEqual({ saldo_punten: 1, feestdag_achterstand: 0.6 });
    expect(s.get(w.z)).toEqual({ saldo_punten: 10, feestdag_achterstand: 1.33 });
    zetStatus(w.a, 'GEGENEREERD');
    try {
      expect((await maakB()).get(w.x)).toEqual({ saldo_punten: -10, feestdag_achterstand: -1.33 });
    } finally {
      zetStatus(w.a, 'GEPUBLICEERD');
    }
    expect(laadAiosRooster(aiosUitnodigPeriode(w.b)!).per_aios.find((a) => a.person_id === w.z)!.saldo_bron).toBe('BEGINSTAND');
  });

  it('a new file replaces what was', async () => {
    await inlezen(req(`${w.b}/geschiedenis`, 'POST', { bestand: bestand([KOP, [cn('y'), 4, 0, 0, 0, 0, 0, 1, 6]]), toepassen: true }), ctx(w.b));
    const stand = (await (await geschiedenis(req(`${w.b}/geschiedenis`), ctx(w.b))).json()).data;
    expect(stand.rijen.map((r: any) => [r.codenaam, r.gevolg])).toEqual([[cn('y'), 'niets in te halen']]);
  });

  it("is the AIOS's planner's: the achterwacht's planner gets nothing, nor an achterwacht period", async () => {
    const stafCookie = staffCookie(staf.planner);
    expect((await geschiedenis(req(`${w.b}/geschiedenis`, 'GET', undefined, stafCookie), ctx(w.b))).status).toBe(404);
    expect((await sjabloon(req(`${w.b}/geschiedenis-sjabloon`, 'GET', undefined, stafCookie), ctx(w.b))).status).toBe(404);
    const leeg = bestand([KOP]);
    expect((await inlezen(req(`${w.b}/geschiedenis`, 'POST', { bestand: leeg, toepassen: true }, stafCookie), ctx(w.b))).status).toBe(404);
    expect((await geschiedenis(req(`${staf.period}/geschiedenis`), ctx(staf.period))).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_aios_beginstand WHERE pool_id = ?').get(w.pool)).toEqual({ n: 1 });
  });
});

describe('over more quarters', () => {
  it('counts each quarter once: who did their share in B carries nothing into C, whatever A left them', async () => {
    // x came into B with a point to make up from A (their share 4, they did 3);
    // the solver puts that in B's share: 5, y 2.
    perAios = (invoer) => invoer.aios.map((a: { id: string }) => ({ aios_id: a.id, doel_punten: a.id === w.x ? 5 : 2, doel_feestdagdiensten: 0 }));
    expect((await maakB()).get(w.x)).toEqual({ saldo_punten: 1, feestdag_achterstand: 0.6 });
    const n = nachten(w.b);
    n.slice(0, 5).forEach((x) => insert('dienstrooster_assignment', { schedule_version_id: w.b, person_id: w.x, slot_id: x.id, bron: 'MANUAL', row_version: 1, aangemaakt_op: now }));
    n.slice(5, 7).forEach((x) => insert('dienstrooster_assignment', { schedule_version_id: w.b, person_id: w.y, slot_id: x.id, bron: 'MANUAL', row_version: 1, aangemaakt_op: now }));
    zetStatus(w.b, 'GEPUBLICEERD');
    const c = insert('dienstrooster_schedule_period', {
      pool_id: w.pool,
      naam: `AiosSaldo-C-${tag}`,
      start_datum: '2094-08-04',
      eind_datum: '2094-08-17',
      deadline: '2094-05-01T17:00',
      status: 'GESLOTEN',
      auto_herinneren: 0,
      aangemaakt_op: now,
    });
    try {
      const s = aiosSaldi({ id: c, pool_id: w.pool, start_datum: '2094-08-04' }, [w.x, w.y]);
      // B's share already held what A left: counted again, x would get a point extra in C.
      expect(s.get(w.x)).toEqual({ saldo_punten: 0, feestdag_achterstand: 0, bron: 'VORIG_KWARTAAL' });
      expect(s.get(w.y)).toEqual({ saldo_punten: 0, feestdag_achterstand: 0, bron: 'VORIG_KWARTAAL' });
      // One night less in B for x: one point to make up in C, not two.
      db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ? AND slot_id = ?').run(w.b, n[0].id);
      expect(aiosSaldi({ id: c, pool_id: w.pool, start_datum: '2094-08-04' }, [w.x]).get(w.x)!.saldo_punten).toBe(1);
    } finally {
      db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(w.b);
      zetStatus(w.b, 'GESLOTEN');
    }
  });
});
