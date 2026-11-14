import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { setAiosVoorkeur } from '@/lib/aiosPreferences';
import { aiosGeneratieJob } from '@/lib/aiosGenereren';
import { laadAiosRooster } from '@/lib/aiosRooster';
import { aiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { purgePeriodNow } from '@/lib/periodTrash';
import { GET as vragen, PUT as bewaren } from './periode/[id]/feestdagblokken/route';
import { POST as genereren } from './periode/[id]/genereren/route';
import { POST as heropenen } from './periode/[id]/heropenen/route';
import { POST as roosterVerwijderen } from './periode/[id]/rooster-verwijderen/route';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, staff, staffCookie, tag, type World } from '../../../tests/fixtures/dienstWorlds';

/**
 * The blocks around feestdagen and New Year's Eve (lib/aiosFeestdagBlokken.ts,
 * docs/aios-rooster.md "Blokken rond feestdagen"), against a fake AIOS-solver
 * that records what the app sends:
 * - feestdagen in a row ask per block they fall in, evening and night apart,
 *   with no default: no roster before each is answered;
 * - a block with a single feestdag stays whole unless cut up;
 * - a cut block goes to the solver as vorm LOS, and the roster shows it per day;
 * - the choices stay with the period and count from the next generation;
 * - 31 December in the quarter: two AIOS unless the planner says one; with two
 *   a second night without a block, made when a generation starts, with the
 *   block's night's marks, and taken away on one or on reopening the period;
 * - the AIOS's planner's only, with an audit row per change.
 */

let snapshot: Map<string, number>;
let staf: World;
let server: http.Server;
const opgevangen: Array<Record<string, any>> = [];
const bewaardeUrl = process.env.AIOS_SOLVER_URL;
const w = {} as { pool: string; q2: string; q4: string; planner: string; x: string; y: string };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (pad: string, cookie: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://localhost/api/aios/periode/${pad}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const haal = async (period: string) => (await (await vragen(req(`${period}/feestdagblokken`, staffCookie(w.planner)), ctx(period))).json()).data;
const zet = (period: string, body: unknown, cookie = staffCookie(w.planner)) =>
  bewaren(req(`${period}/feestdagblokken`, cookie, 'PUT', body), ctx(period));
const status = (period: string) =>
  (db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(period) as { status: string }).status;
const zetStatus = (period: string, s: string) => db.prepare('UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?').run(s, period);

async function maak(period: string) {
  const res = await genereren(req(`${period}/genereren`, staffCookie(w.planner), 'POST', {}), ctx(period));
  if (res.status !== 202) return res;
  const jobId = (await res.json()).data.job_id as string;
  for (let i = 0; i < 200; i++) {
    const job = aiosGeneratieJob(jobId, period)!;
    if (job.status !== 'BEZIG') {
      expect(job.status).toBe('KLAAR');
      return res;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('generation did not finish');
}

const nachten = (period: string, datum: string) =>
  db
    .prepare(
      `SELECT sl.id, sl.shift_block_id AS blok FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND sl.datum = ? AND st.code = 'ND' ORDER BY sl.shift_block_id IS NULL`
    )
    .all(period, datum) as Array<{ id: string; blok: string | null }>;

const markeringen = (slot: string) =>
  db.prepare('SELECT person_id, blocking_level, source FROM dienstrooster_availability WHERE slot_id = ? ORDER BY person_id').all(slot);

beforeAll(async () => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosFd-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosFd-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  const periode = (jaar: number, kwartaal: 2 | 4) => {
    const q = aiosQuarter(jaar, kwartaal);
    const id = insert('dienstrooster_schedule_period', {
      pool_id: w.pool,
      naam: `AiosFd-${kwartaal}-${tag}`,
      start_datum: q.start_datum,
      eind_datum: q.eind_datum,
      deadline: '2096-02-10T17:00',
      status: 'OPEN',
      auto_herinneren: 0,
      aangemaakt_op: now,
    });
    db.transaction(() => persistAiosSlots(id, aiosShiftTypes(w.pool)!, q.start_datum, q.eind_datum))();
    return id;
  };
  // 2096 Q2: Pasen (zo 15 and ma 16 april) and Pinksteren (zo 3 and ma 4 juni),
  // Koningsdag on a Friday and Hemelvaart on a Thursday.
  w.q2 = periode(2096, 2);
  // 2096 Q4, to 1 January 2097: kerst on Tuesday and Wednesday, oudjaar on Monday, Nieuwjaarsdag.
  w.q4 = periode(2096, 4);
  const deelnemer = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: `aiosfd-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
  // y marks the night block with oudjaar in it liever niet: the second night gets that too.
  const blokNacht = nachten(w.q4, '2096-12-31')[0];
  expect(setAiosVoorkeur(w.y, w.q4, blokNacht.id, 'LIEVER_NIET')).toEqual({ ok: true });
  zetStatus(w.q2, 'GESLOTEN');
  zetStatus(w.q4, 'GESLOTEN');

  server = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => (body += c));
    rq.on('end', () => {
      opgevangen.push(JSON.parse(body));
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

beforeEach(() => {
  opgevangen.length = 0;
});

describe('blocks around feestdagen', () => {
  it('asks per block of feestdagen in a row, evening and night apart, with no default', async () => {
    const v = await haal(w.q2);
    expect(v.groepen.map((g: any) => g.datums)).toEqual([
      ['2096-04-15', '2096-04-16'],
      ['2096-06-03', '2096-06-04'],
    ]);
    expect(v.groepen[0].namen).toEqual(['Eerste Paasdag', 'Tweede Paasdag']);
    for (const g of v.groepen) {
      expect(g.blokken.map((b: any) => `${b.soort} ${b.vorm}`).sort()).toEqual(['AVOND ZO_DI', 'NACHT ZO_DI']);
      expect(g.blokken.every((b: any) => b.verplicht && b.keuze === null)).toBe(true);
    }
    expect(v.open).toBe(4);
    // Koningsdag and Hemelvaart: whole unless cut up.
    expect(v.losse.map((b: any) => `${b.start_datum} ${b.soort}`).sort()).toEqual([
      '2096-04-25 AVOND',
      '2096-04-25 NACHT',
      '2096-05-23 AVOND',
      '2096-05-23 NACHT',
    ]);
    expect(v.losse.every((b: any) => !b.verplicht && b.keuze === 'HEEL')).toBe(true);
    expect(v.oudjaar).toBeNull();
  });

  it('makes no roster before every question is answered', async () => {
    const res = await maak(w.q2);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: 'QUESTIONS_OPEN', message: expect.stringMatching(/nog 4 blokken zonder keuze/) });
    const pasen = (await haal(w.q2)).groepen[0].blokken;
    expect((await zet(w.q2, { keuzes: pasen.map((b: any) => ({ blok_id: b.blok_id, keuze: 'HEEL' })) })).status).toBe(200);
    const nog = await maak(w.q2);
    expect(nog.status).toBe(409);
    expect((await nog.json()).error.message).toMatch(/nog 2 blokken zonder keuze/);
    expect(opgevangen).toHaveLength(0);
  });

  it('sends a cut block as LOS, the rest as made, and shows it per day', async () => {
    const v = await haal(w.q2);
    const [avond, nacht] = [...v.groepen[1].blokken].sort((a: any, b: any) => a.soort.localeCompare(b.soort));
    const koningsdag = v.losse.find((b: any) => b.start_datum === '2096-04-25' && b.soort === 'NACHT');
    const res = await zet(w.q2, {
      keuzes: [
        { blok_id: avond.blok_id, keuze: 'HEEL' },
        { blok_id: nacht.blok_id, keuze: 'OPKNIPPEN' },
        { blok_id: koningsdag.blok_id, keuze: 'OPKNIPPEN' },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.open).toBe(0);
    expect((await maak(w.q2)).status).toBe(202);
    const invoer = opgevangen[0];
    const vorm = new Map(invoer.blokken.map((b: any) => [b.id, b.vorm]));
    expect(vorm.get(nacht.blok_id)).toBe('LOS');
    expect(vorm.get(koningsdag.blok_id)).toBe('LOS');
    expect(vorm.get(avond.blok_id)).toBe('ZO_DI');
    const gemaakt = db.prepare('SELECT id, vorm FROM dienstrooster_shift_block WHERE period_id = ?').all(w.q2) as Array<{ id: string; vorm: string }>;
    expect(invoer.blokken.filter((b: any) => b.vorm === 'LOS').map((b: any) => b.id).sort()).toEqual([nacht.blok_id, koningsdag.blok_id].sort());
    // The blocks themselves stay as they were made.
    expect(gemaakt.every((b) => b.vorm !== 'LOS')).toBe(true);
    expect(invoer.diensten.filter((d: any) => d.blok_id === nacht.blok_id)).toHaveLength(3);

    const blokVan = new Map(
      laadAiosRooster(aiosUitnodigPeriode(w.q2)!)
        .dagen.flatMap((d) => d.diensten)
        .filter((d) => d.blok)
        .map((d) => [d.blok!.id, d.blok!.vorm])
    );
    expect(blokVan.get(nacht.blok_id)).toBe('LOS');
    expect(blokVan.get(avond.blok_id)).toBe('ZO_DI');
  });

  it('keeps the choices with the period, and a block left out keeps its own', async () => {
    const v = await haal(w.q2);
    expect(v.open).toBe(0);
    const pinksterNacht = v.groepen[1].blokken.find((b: any) => b.soort === 'NACHT');
    expect(pinksterNacht.keuze).toBe('OPKNIPPEN');
    expect((await zet(w.q2, { keuzes: [{ blok_id: pinksterNacht.blok_id, keuze: 'HEEL' }] })).status).toBe(200);
    const na = await haal(w.q2);
    expect(na.groepen[1].blokken.find((b: any) => b.soort === 'NACHT').keuze).toBe('HEEL');
    expect(na.losse.find((b: any) => b.start_datum === '2096-04-25' && b.soort === 'NACHT').keuze).toBe('OPKNIPPEN');
    const audit = db
      .prepare(`SELECT nieuw_json FROM dienstrooster_audit_log WHERE entiteit_id = ? AND nieuw_json LIKE '%blokken rond feestdagen%' ORDER BY tijdstip DESC, rowid DESC`)
      .get(w.q2) as { nieuw_json: string };
    expect(JSON.parse(audit.nieuw_json).blokken[pinksterNacht.blok_id]).toBe('HEEL');
  });

  it('refuses what is not a question of this period', async () => {
    const zonder = db
      .prepare(
        `SELECT b.id FROM dienstrooster_shift_block b WHERE b.period_id = ? AND b.vorm = 'ZO_DI'
         AND NOT EXISTS (SELECT 1 FROM dienstrooster_shift_slot s WHERE s.shift_block_id = b.id AND s.is_feestdag = 1) LIMIT 1`
      )
      .get(w.q2) as { id: string };
    const vreemd = (await haal(w.q4)).groepen[0].blokken[0].blok_id;
    const pasen = (await haal(w.q2)).groepen[0].blokken[0].blok_id;
    for (const body of [
      { keuzes: [{ blok_id: zonder.id, keuze: 'OPKNIPPEN' }] },
      { keuzes: [{ blok_id: vreemd, keuze: 'OPKNIPPEN' }] },
      { keuzes: [{ blok_id: pasen, keuze: 'HALF' }] },
      { keuzes: [{ blok_id: pasen }] },
      { keuzes: 'OPKNIPPEN' },
      { keuzes: [pasen] },
      { oudjaar_aantal: 2 }, // no 31 December in this quarter
    ]) {
      const res = await zet(w.q2, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await zet(w.q4, { oudjaar_aantal: 3 })).status).toBe(400);
    expect((await zet(w.q4, { oudjaar_aantal: '1' })).status).toBe(400);
    expect((await haal(w.q2)).groepen[0].blokken.every((b: any) => b.keuze === 'HEEL')).toBe(true);
  });

  it('fixed once published', async () => {
    zetStatus(w.q2, 'GEPUBLICEERD');
    const res = await zet(w.q2, { keuzes: [] });
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/liggen vast/);
    zetStatus(w.q2, 'GEGENEREERD');
  });
});

describe("New Year's Eve", () => {
  it('two AIOS unless the planner says one', async () => {
    const v = await haal(w.q4);
    expect(v.oudjaar).toEqual({ datum: '2096-12-31', aantal: 2 });
    // Kerst on Tuesday and Wednesday: the zo t/m di and the wo t/m vr block, evening and night.
    expect(v.groepen.map((g: any) => g.datums)).toEqual([['2096-12-25', '2096-12-26']]);
    expect(v.groepen[0].blokken).toHaveLength(4);
    // Nieuwjaarsdag in the zo t/m di block with oudjaar: whole unless cut up.
    expect(v.losse.map((b: any) => `${b.start_datum} ${b.soort}`).sort()).toEqual(['2096-12-30 AVOND', '2096-12-30 NACHT']);
    expect(nachten(w.q4, '2096-12-31')).toHaveLength(1);
  });

  it('a generation makes the second night, without a block and with the marks of the block night', async () => {
    const kerst = (await haal(w.q4)).groepen[0].blokken;
    expect((await zet(w.q4, { keuzes: kerst.map((b: any) => ({ blok_id: b.blok_id, keuze: 'HEEL' })) })).status).toBe(200);
    // Saving makes nothing yet: only a generation does.
    expect(nachten(w.q4, '2096-12-31')).toHaveLength(1);
    expect((await maak(w.q4)).status).toBe(202);
    const [blokNacht, tweede] = nachten(w.q4, '2096-12-31');
    expect(blokNacht.blok).not.toBeNull();
    expect(tweede.blok).toBeNull();
    expect(markeringen(tweede.id)).toEqual(markeringen(blokNacht.id));
    expect(markeringen(tweede.id)).toEqual([expect.objectContaining({ person_id: w.y, blocking_level: 'LIEVER_NIET', source: 'MANUAL' })]);
    const dienst = opgevangen[0].diensten.find((d: any) => d.id === tweede.id);
    expect(dienst).toMatchObject({ code: 'ND', datum: '2096-12-31', blok_id: null });
    expect(opgevangen[0].aios.find((a: any) => a.id === w.y).markeringen).toEqual(
      expect.arrayContaining([expect.objectContaining({ dienst_id: tweede.id, niveau: 'LIEVER_NIET' })])
    );
    const nacht2 = laadAiosRooster(aiosUitnodigPeriode(w.q4)!)
      .dagen.find((d) => d.datum === '2096-12-31')!
      .diensten.filter((d) => d.code === 'ND');
    expect(nacht2.map((d) => d.blok === null)).toEqual([false, true]);

    // Again: still one second night, its marks those of now.
    db.prepare('DELETE FROM dienstrooster_availability WHERE slot_id = ?').run(blokNacht.id);
    zetStatus(w.q4, 'GESLOTEN');
    expect((await maak(w.q4)).status).toBe(202);
    expect(nachten(w.q4, '2096-12-31')).toHaveLength(2);
    expect(markeringen(tweede.id)).toEqual([]);
  });

  it('one AIOS: the second night goes at the next generation, with whoever had it', async () => {
    const tweede = nachten(w.q4, '2096-12-31')[1];
    const toewijzing = insert('dienstrooster_assignment', { schedule_version_id: w.q4, person_id: w.x, slot_id: tweede.id, bron: 'MANUAL', row_version: 1, aangemaakt_op: now });
    // Given by hand (lib/aiosHandmatig.ts): that row goes with the night.
    insert('dienstrooster_assignment_edit', {
      toewijzing_id: toewijzing,
      periode_id: w.q4,
      person_id: w.x,
      slot_id: tweede.id,
      edit_type: 'HANDMATIG_TOEWIJZEN',
      bewerkt_door_person_id: w.planner,
      aangemaakt_op: now,
      row_version: 1,
    });
    expect((await zet(w.q4, { oudjaar_aantal: 1 })).status).toBe(200);
    expect((await haal(w.q4)).oudjaar.aantal).toBe(1);
    expect(nachten(w.q4, '2096-12-31')).toHaveLength(2);
    expect((await maak(w.q4)).status).toBe(202);
    expect(nachten(w.q4, '2096-12-31')).toHaveLength(1);
    expect(opgevangen[0].diensten.some((d: any) => d.id === tweede.id)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_assignment WHERE slot_id = ?').get(tweede.id)).toEqual({ n: 0 });
  });

  it('reopening the period takes the second night away: the AIOS mark the block', async () => {
    expect((await zet(w.q4, { oudjaar_aantal: 2 })).status).toBe(200);
    zetStatus(w.q4, 'GESLOTEN');
    expect((await maak(w.q4)).status).toBe(202);
    expect(nachten(w.q4, '2096-12-31')).toHaveLength(2);
    zetStatus(w.q4, 'GESLOTEN');
    const res = await heropenen(req(`${w.q4}/heropenen`, staffCookie(w.planner), 'POST'), ctx(w.q4));
    expect(res.status).toBe(200);
    expect(status(w.q4)).toBe('OPEN');
    expect(nachten(w.q4, '2096-12-31')).toHaveLength(1);
    expect((await haal(w.q4)).oudjaar.aantal).toBe(2);
  });

  it('removing the roster takes the second night away too: the overview of the closed period has one night that day', async () => {
    expect((await zet(w.q4, { oudjaar_aantal: 2 })).status).toBe(200);
    zetStatus(w.q4, 'GESLOTEN');
    expect((await maak(w.q4)).status).toBe(202);
    expect(nachten(w.q4, '2096-12-31')).toHaveLength(2);
    expect(status(w.q4)).toBe('GEGENEREERD');
    const res = await roosterVerwijderen(req(`${w.q4}/rooster-verwijderen`, staffCookie(w.planner), 'POST', {}), ctx(w.q4));
    expect(res.status).toBe(200);
    expect(status(w.q4)).toBe('GESLOTEN');
    // Two rows for one date and dienst made the voorkeurenoverzicht refuse itself on import.
    expect(nachten(w.q4, '2096-12-31')).toHaveLength(1);
    expect((await haal(w.q4)).oudjaar.aantal).toBe(2);
  });
});

describe('access and clean-up', () => {
  it("is the AIOS's planner's: the achterwacht's planner gets nothing, nor an achterwacht period", async () => {
    const stafCookie = staffCookie(staf.planner);
    expect((await vragen(req(`${w.q4}/feestdagblokken`, stafCookie), ctx(w.q4))).status).toBe(404);
    expect((await zet(w.q4, { oudjaar_aantal: 1 }, stafCookie)).status).toBe(404);
    expect((await vragen(req(`${staf.period}/feestdagblokken`, staffCookie(w.planner)), ctx(staf.period))).status).toBe(404);
    expect((await haal(w.q4)).oudjaar.aantal).toBe(2);
  });

  it('a period purged takes its choices with it', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_aios_blokkeuze WHERE period_id = ?').get(w.q2)).not.toEqual({ n: 0 });
    db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?').run(now, w.q2);
    purgePeriodNow(w.q2, w.planner);
    expect(db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_aios_blokkeuze WHERE period_id = ?').get(w.q2)).toEqual({ n: 0 });
  });
});
