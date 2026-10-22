import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { syncAiosPeriode } from '@/lib/aiosSync';
import { loadAiosPeriode, saveAiosWens, setAiosVoorkeur } from '@/lib/aiosPreferences';
import { readFirstSheet } from '@/lib/xlsx';
import { excelSerialToDate } from '@/lib/isoDate';
import { GET as voorkeuren } from './periode/[id]/download-voorkeuren/route';
import { GET as verzoeken } from './periode/[id]/download-verzoeken/route';
import {
  buildWorld,
  deleteRowsAfter,
  insert,
  now,
  personCookie,
  rowidSnapshot,
  staff,
  staffCookie,
  tag,
  type World,
} from '../../../tests/fixtures/dienstWorlds';

/**
 * The rules of the AIOS planner's two downloads (lib/aiosDownloads.ts):
 * - Voorkeuren per dienst: a row for every dienst of the quarter, a column
 *   for every AIOS taking part (also one who marked nothing) and nobody
 *   else; a block's mark on each of its diensten, in words, with why when
 *   leave set it; the block and the feestdag named; the date a real date.
 * - Verzoeken per AIOS: a row per AIOS with what they asked (4 nachten,
 *   inwerken), their absences in words, the counters and,
 *   above half, how many may still be rostered.
 * - Only the AIOS's planner and the beheerder: the achterwacht's planner
 *   and a participant get nothing, and an achterwacht period answers 404.
 */

let snapshot: Map<string, number>;
let staf: World;
const w = {} as { pool: string; period: string; planner: string; admin: string; x: string; y: string; z: string };
const codenaam = (n: string) => `aiosdl-${n}-${tag}`;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (pad: string, cookie: string) =>
  new NextRequest(`http://localhost/api/aios/periode/${pad}`, { headers: { cookie } });

async function blad(route: typeof voorkeuren, periodId: string, cookie = staffCookie(w.planner)): Promise<string[][]> {
  const res = await route(req(`${periodId}/x`, cookie), ctx(periodId));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('spreadsheetml');
  return readFirstSheet(Buffer.from(await res.arrayBuffer()));
}

/** The slots of one block, and the block's first night dienst. */
function nachtblok(): { blok: string; slots: string[] } {
  const rows = db
    .prepare(
      `SELECT s.id, s.shift_block_id AS blok FROM dienstrooster_shift_slot s
       JOIN dienstrooster_shift_block b ON b.id = s.shift_block_id
       WHERE s.period_id = ? AND b.soort = 'NACHT' AND b.vorm = 'WO_VR' AND s.is_feestdag = 0
       ORDER BY s.datum`
    )
    .all(w.period) as Array<{ id: string; blok: string }>;
  const blok = rows[0].blok;
  return { blok, slots: rows.filter((r) => r.blok === blok).map((r) => r.id) };
}

beforeAll(() => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  w.admin = staff('ADMIN', 'ACHTERWACHT');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosDl-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosDl-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  // 2097 Q2: with Easter Monday, Koningsdag and Hemelvaart in it.
  const q = aiosQuarter(2097, 2);
  w.period = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `AiosDl-${tag}`,
    start_datum: q.start_datum,
    eind_datum: q.eind_datum,
    deadline: '2097-02-10T17:00',
    status: 'OPEN',
    auto_herinneren: 0,
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(w.period, aiosShiftTypes(w.pool)!, q.start_datum, q.eind_datum))();
  const deelnemer = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: codenaam(n), rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    insert('dienstrooster_person_access_link', { person_id: id, token_hash: `aiosdl-${n}-${tag}`, aangemaakt_op: now });
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
  w.z = deelnemer('z');
  // y on leave on Friday 26 April and Koningsdag, Saturday 27 April 2097.
  insert('dienstrooster_absence', { person_id: w.y, van_datum: '2097-04-26', tot_datum: '2097-04-27', soort: 'VAKANTIE', aangemaakt_door: w.y, aangemaakt_op: now });
  syncAiosPeriode(w.period);
  // x blocks a night block and asks for 4 nachten, inwerken and a remark.
  const periode = loadAiosPeriode(w.period)!;
  expect(setAiosVoorkeur(w.x, w.period, nachtblok().slots[0], 'ABSOLUUT')).toEqual({ ok: true });
  expect(
    saveAiosWens(w.x, periode, {
      vier_nachten: true,
      inwerken_van: q.start_datum,
      inwerken_tot: '2097-04-30',
    })
  ).toEqual({ ok: true });
});

afterAll(() => {
  deleteRowsAfter(snapshot);
});

describe('Voorkeuren per dienst', () => {
  it('has a row for every dienst of the quarter and a column for every AIOS, nobody else', async () => {
    const rows = await blad(voorkeuren, w.period);
    const [kop, ...diensten] = rows;
    expect(kop.slice(0, 7)).toEqual(['Datum', 'Dag', 'Week', 'Dienst', 'Tijd', 'Blok', 'Feestdag']);
    expect(kop.slice(7)).toEqual([codenaam('x'), codenaam('y'), codenaam('z')]);
    const aantal = (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_shift_slot WHERE period_id = ?').get(w.period) as { n: number }).n;
    // The five requests and the two part-time rows come first (the file is the back-up), then the diensten.
    expect(diensten.slice(0, 7).map((r) => r[3])).toEqual([
      'Verzoek: 4 avonden (wo t/m za)',
      'Verzoek: 4 nachten (wo t/m za)',
      'Verzoek: twee dagdiensten (za en zo)',
      'Verzoek: inwerken',
      'Verzoek: onderbreking van de opleiding',
      'Parttime 1',
      'Parttime 2',
    ]);
    const x = kop.indexOf(codenaam('x'));
    expect(diensten[1][x]).toBe('ja');
    expect(diensten[3][x]).toMatch(/^\d{2}-\d{2}-2097 t\/m 30-04-2097$/);
    expect(diensten.slice(7)).toHaveLength(aantal);
    // The date is a real date, in order from the quarter's first day.
    expect(excelSerialToDate(Number(diensten[7][0]))).toBe(aiosQuarter(2097, 2).start_datum);
  });

  it("puts a block's mark on each of its diensten, and says why when leave set it", async () => {
    const rows = await blad(voorkeuren, w.period);
    const kolom = (n: string) => rows[0].indexOf(codenaam(n));
    const { slots } = nachtblok();
    const datums = (db.prepare(`SELECT datum FROM dienstrooster_shift_slot WHERE id IN (${slots.map(() => '?').join(',')})`).all(...slots) as Array<{ datum: string }>).map((r) => r.datum);
    const blokRijen = rows.slice(1).filter((r) => datums.includes(excelSerialToDate(Number(r[0]))!) && r[5]?.startsWith('nachtblok'));
    expect(blokRijen).toHaveLength(slots.length);
    for (const r of blokRijen) {
      expect(r[5]).toBe('nachtblok wo t/m vr');
      expect(r[kolom('x')]).toBe('geblokkeerd');
    }
    // Leave on a weekday blocks; on Koningsdag it is liever niet.
    const koningsdag = rows.slice(1).filter((r) => r[6] === 'Koningsdag');
    expect(koningsdag.length).toBeGreaterThan(0);
    expect(new Set(koningsdag.map((r) => r[kolom('y')]))).toEqual(new Set(['liever niet (afwezig: vakantie)']));
    const dagErvoor = rows.slice(1).filter((r) => excelSerialToDate(Number(r[0])) === '2097-04-26');
    expect(new Set(dagErvoor.map((r) => r[kolom('y')]))).toEqual(new Set(['geblokkeerd (afwezig: vakantie)']));
    // z marked nothing: an empty column, not a missing one.
    expect(rows.slice(1).every((r) => !r[kolom('z')])).toBe(true);
  });
});

describe('Verzoeken per AIOS', () => {
  it('has a row per AIOS with what they asked, their leave and the counters', async () => {
    const [kop, ...rijen] = await blad(verzoeken, w.period);
    expect(rijen.map((r) => r[0])).toEqual([codenaam('x'), codenaam('y'), codenaam('z')]);
    const cel = (r: string[], k: string) => r[kop.indexOf(k)] ?? '';
    const [x, y, z] = rijen;
    expect(cel(x, 'Status')).toBe('Bezig, nog niet ingediend');
    expect(cel(x, '4 nachten (wo t/m za)')).toBe('ja');
    expect(cel(x, '4 avonden (wo t/m za)')).toBe('');
    expect(cel(x, 'Inwerken')).toMatch(/^\d+ \w+\.? 2097 t\/m 30 apr\.? 2097$/);
    expect(kop).not.toContain('Opmerking');
    expect(cel(x, 'Geblokkeerd (vakken)')).toBe('1');
    expect(cel(x, 'Geblokkeerd: nachtblokken')).toMatch(/^1 van de \d+$/);
    expect(cel(x, 'Boven de helft: nachtblokken')).toBe('');
    expect(cel(y, 'Afwezigheid')).toMatch(/^vakantie 26 apr\.? 2097 t\/m 27 apr\.? 2097$/);
    expect(cel(z, 'Status')).toBe('Nog niets ingevuld');
  });

  it('names the soort of the absence behind a blocked day, both when two overlap', async () => {
    const id = insert('dienstrooster_absence', { person_id: w.y, van_datum: '2097-04-27', tot_datum: '2097-04-27', soort: 'ONDERWIJS', aangemaakt_door: w.y, aangemaakt_op: now });
    try {
      const rows = await blad(voorkeuren, w.period);
      const kolom = (n: string) => rows[0].indexOf(codenaam(n));
      const op = (datum: string) => new Set(rows.slice(1).filter((r) => excelSerialToDate(Number(r[0])) === datum).map((r) => r[kolom('y')]));
      expect(op('2097-04-26')).toEqual(new Set(['geblokkeerd (afwezig: vakantie)']));
      expect(op('2097-04-27')).toEqual(new Set(['liever niet (afwezig: vakantie en onderwijs)']));
    } finally {
      db.prepare('DELETE FROM dienstrooster_absence WHERE id = ?').run(id);
    }
  });

  it('names an absence for onderwijs', async () => {
    const id = insert('dienstrooster_absence', { person_id: w.z, van_datum: '2097-04-28', tot_datum: '2097-04-28', soort: 'ONDERWIJS', aangemaakt_door: w.z, aangemaakt_op: now });
    try {
      const [kop, ...rijen] = await blad(verzoeken, w.period);
      const z = rijen.find((r) => r[0] === codenaam('z'))!;
      expect(z[kop.indexOf('Afwezigheid')]).toMatch(/^onderwijs 28 apr\.? 2097 t\/m 28 apr\.? 2097$/);
    } finally {
      db.prepare('DELETE FROM dienstrooster_absence WHERE id = ?').run(id);
    }
  });

  it('says how many may still be rostered once someone blocked more than half', async () => {
    const blokken = db
      .prepare(
        `SELECT b.id, MIN(s.id) AS slot FROM dienstrooster_shift_block b JOIN dienstrooster_shift_slot s ON s.shift_block_id = b.id
         WHERE b.period_id = ? AND b.soort = 'NACHT' AND b.vorm IN ('ZO_DI', 'WO_VR')
           AND NOT EXISTS (SELECT 1 FROM dienstrooster_shift_slot f WHERE f.shift_block_id = b.id AND f.is_feestdag = 1)
         GROUP BY b.id ORDER BY MIN(s.datum)`
      )
      .all(w.period) as Array<{ id: string; slot: string }>;
    // A block with a feestdag in it can't be blocked, so it is not in the total either.
    const totaal = blokken.length;
    const nodig = Math.floor(totaal / 2) + 2;
    for (const b of blokken.slice(0, nodig)) expect(setAiosVoorkeur(w.z, w.period, b.slot, 'ABSOLUUT')).toEqual({ ok: true });
    const [kop, , , z] = await blad(verzoeken, w.period);
    expect(z[kop.indexOf('Geblokkeerd: nachtblokken')]).toBe(`${nodig} van de ${totaal}`);
    expect(z[kop.indexOf('Boven de helft: nachtblokken')]).toBe('meer dan de helft, hoogstens 2 alsnog in te plannen');
  });
});

describe('who may download them', () => {
  it("lets the AIOS's planner and the beheerder, not the achterwacht's planner nor a participant", async () => {
    for (const route of [voorkeuren, verzoeken]) {
      expect((await route(req(w.period, staffCookie(w.admin)), ctx(w.period))).status).toBe(200);
      expect((await route(req(w.period, staffCookie(staf.planner)), ctx(w.period))).status).toBe(404);
      expect((await route(req(w.period, personCookie(w.x)), ctx(w.period))).status).toBe(401);
      // An achterwacht period is not the AIOS's, also not for the beheerder.
      expect((await route(req(staf.period, staffCookie(w.admin)), ctx(staf.period))).status).toBe(404);
    }
  });
});
