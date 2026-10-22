import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { syncAiosPeriode } from '@/lib/aiosSync';
import { setAiosVoorkeur, loadAiosPeriode, loadAiosWens, saveAiosWens } from '@/lib/aiosPreferences';
import { saveAiosReden, loadAiosRedenen } from '@/lib/aiosReden';
import { voegPatroonToe } from '@/lib/aiosDeeltijd';
import { readFirstSheet } from '@/lib/xlsx';
import { excelSerialToDate } from '@/lib/isoDate';
import { buildXlsx } from '@/tests/fixtures/buildXlsx';
import { GET as voorkeuren } from './periode/[id]/download-voorkeuren/route';
import { POST as importeren } from './periode/[id]/voorkeuren-import/route';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, staff, staffCookie, tag, type World } from '../../../tests/fixtures/dienstWorlds';

/**
 * The AIOS's voorkeurenoverzicht read back in (lib/aiosVoorkeurImport.ts):
 * - only the beheerder, only an AIOS period, only before the roster is made;
 * - the overview read back unchanged changes nothing, toelichting included;
 * - a changed cell sets the mark as the AIOS's screen would (a block whole),
 *   an emptied one takes a hand mark away, "(parttime)" and "(afwezig)"
 *   cells are never touched;
 * - the toelichting follows the text after the colon, one a day;
 * - checking says exactly what applying does, and a file with problems is
 *   refused whole.
 */

let snapshot: Map<string, number>;
let staf: World;
const w = {} as { pool: string; period: string; planner: string; admin: string; x: string; y: string; z: string };
const q = aiosQuarter(2097, 2);
const cn = (n: string) => `aiosimp-${n}-${tag}`;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const gelezen = async (): Promise<string[][]> => {
  const res = await voorkeuren(
    new NextRequest(`http://localhost/api/aios/periode/${w.period}/download-voorkeuren`, { headers: { cookie: staffCookie(w.admin) } }),
    ctx(w.period)
  );
  return readFirstSheet(Buffer.from(await res.arrayBuffer()));
};
const importeer = async (rows: string[][], toepassen: boolean, als = w.admin, periode = w.period) => {
  const res = await importeren(
    new NextRequest(`http://localhost/api/aios/periode/${periode}/voorkeuren-import`, {
      method: 'POST',
      headers: { cookie: staffCookie(als), 'content-type': 'application/json' },
      body: JSON.stringify({ bestand: buildXlsx(rows).toString('base64'), toepassen }),
    }),
    ctx(periode)
  );
  return { status: res.status, json: await res.json() };
};
const kopieer = (rows: string[][]) => rows.map((r) => [...r]);
const kolom = (rows: string[][], n: string) => rows[0].indexOf(cn(n));
const rijen = (rows: string[][], datum: string, code: string) =>
  rows.filter((r, i) => i > 0 && excelSerialToDate(Number(r[0])) === datum && r[3].startsWith(`${code} `));
const niveau = (wie: string, datum: string, code: string) =>
  (
    db
      .prepare(
        `SELECT av.blocking_level AS l, av.source AS s FROM dienstrooster_availability av
         JOIN dienstrooster_shift_slot sl ON sl.id = av.slot_id JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
         WHERE av.person_id = ? AND sl.period_id = ? AND sl.datum = ? AND st.code = ?`
      )
      .get(wie, w.period, datum, code) as { l: string; s: string } | undefined
  )?.l ?? null;
const slotId = (datum: string, code: string) =>
  (
    db
      .prepare(
        `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
         WHERE sl.period_id = ? AND sl.datum = ? AND st.code = ?`
      )
      .get(w.period, datum, code) as { id: string }
  ).id;

const UD_DAG = '2097-05-14';
const ANDERE_UD = '2097-05-16';
const WEEKEND_DD = '2097-05-18'; // a Saturday: its dagdienst

/** The three days of one night block wo t/m vr, from the quarter's slots. */
function nachtDagen(): string[] {
  const r = db
    .prepare(
      `SELECT s.datum FROM dienstrooster_shift_slot s JOIN dienstrooster_shift_block b ON b.id = s.shift_block_id
       WHERE s.period_id = ? AND b.soort = 'NACHT' AND b.vorm = 'WO_VR' AND s.is_feestdag = 0 ORDER BY s.datum`
    )
    .all(w.period) as Array<{ datum: string }>;
  return r.slice(0, 3).map((x) => x.datum);
}

beforeAll(() => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  w.admin = staff('ADMIN', 'ACHTERWACHT');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosImp-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosImp-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  w.period = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `AiosImp-${tag}`,
    start_datum: q.start_datum,
    eind_datum: q.eind_datum,
    deadline: '2097-02-10T17:00',
    status: 'OPEN',
    auto_herinneren: 0,
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(w.period, aiosShiftTypes(w.pool)!, q.start_datum, q.eind_datum))();
  const deelnemer = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: cn(n), rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
  w.z = deelnemer('z');
  // y on leave on Friday 26 April and Koningsdag, Saturday 27 April 2097.
  insert('dienstrooster_absence', { person_id: w.y, van_datum: '2097-04-26', tot_datum: '2097-04-27', soort: 'VAKANTIE', aangemaakt_door: w.y, aangemaakt_op: now });
  syncAiosPeriode(w.period);
  // x: the first night block wo t/m vr geblokkeerd, a uitloopdienst liever niet with a toelichting.
  expect(setAiosVoorkeur(w.x, w.period, slotId(nachtDagen()[0], 'ND'), 'ABSOLUUT')).toEqual({ ok: true });
  expect(setAiosVoorkeur(w.x, w.period, slotId(UD_DAG, 'UD'), 'LIEVER_NIET')).toEqual({ ok: true });
  expect(saveAiosReden(w.x, loadAiosPeriode(w.period)!, UD_DAG, 'cursus in Utrecht')).toEqual({ ok: true });
});

afterAll(() => deleteRowsAfter(snapshot));

describe('who may, and when', () => {
  it('only the beheerder: the AIOS planner and the achterwacht planner may not', async () => {
    const rows = await gelezen();
    expect([401, 403]).toContain((await importeer(rows, false, w.planner)).status);
    expect([401, 403]).toContain((await importeer(rows, false, staf.planner)).status);
    expect((await importeer(rows, false)).status).toBe(200);
  });

  it('not an achterwacht period (404), no file, no Excel, not after the roster is made', async () => {
    const rows = await gelezen();
    expect((await importeer(rows, false, w.admin, staf.period)).status).toBe(404);
    const geen = await importeren(
      new NextRequest(`http://localhost/api/aios/periode/${w.period}/voorkeuren-import`, {
        method: 'POST',
        headers: { cookie: staffCookie(w.admin), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      ctx(w.period)
    );
    expect(geen.status).toBe(400);
    const geenExcel = await importeren(
      new NextRequest(`http://localhost/api/aios/periode/${w.period}/voorkeuren-import`, {
        method: 'POST',
        headers: { cookie: staffCookie(w.admin), 'content-type': 'application/json' },
        body: JSON.stringify({ bestand: Buffer.from('geen excel').toString('base64') }),
      }),
      ctx(w.period)
    );
    expect(geenExcel.status).toBe(400);
    for (const status of ['GEGENEREERD', 'GEPUBLICEERD']) {
      db.prepare(`UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?`).run(status, w.period);
      try {
        expect((await importeer(rows, false)).status).toBe(409);
      } finally {
        db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'OPEN' WHERE id = ?`).run(w.period);
      }
    }
  });
});

describe('the overview read back', () => {
  it('unchanged: nothing changes, the toelichting included', async () => {
    const rows = await gelezen();
    // The toelichting is in the file, after the mark.
    expect(rijen(rows, UD_DAG, 'UD')[0][kolom(rows, 'x')]).toBe('liever niet: cursus in Utrecht');
    const gecontroleerd = await importeer(rows, false);
    expect(gecontroleerd.json.data).toMatchObject({ wijzigingen: [], problemen: [], toegepast: false });
    // The absence cells of y were skipped, not read as marks.
    expect(gecontroleerd.json.data.overgeslagen).toBeGreaterThan(0);
    const toegepast = await importeer(rows, true);
    expect(toegepast.json.data).toMatchObject({ wijzigingen: [], problemen: [], toegepast: true });
    expect(loadAiosRedenen(w.x, w.period)).toEqual([{ datum: UD_DAG, tekst: 'cursus in Utrecht' }]);
  });

  it('a changed cell is set, an emptied one cleared, a toelichting follows the text; checking says what applying does', async () => {
    const rows = kopieer(await gelezen());
    const dagen = nachtDagen();
    // y: liever niet on a uitloopdienst, with a toelichting.
    rijen(rows, ANDERE_UD, 'UD')[0][kolom(rows, 'y')] = 'Liever niet: kind naar de dokter';
    // x: the night block emptied (all three), the other toelichting changed.
    for (const d of dagen) rijen(rows, d, 'ND')[0][kolom(rows, 'x')] = '';
    rijen(rows, UD_DAG, 'UD')[0][kolom(rows, 'x')] = 'liever niet: nieuwe cursus';
    // z: a voorkeur.
    rijen(rows, WEEKEND_DD, 'DD')[0][kolom(rows, 'z')] = 'voorkeur';

    const check = await importeer(rows, false);
    expect(check.status).toBe(200);
    expect(check.json.data.problemen).toEqual([]);
    expect(niveau(w.y, ANDERE_UD, 'UD')).toBeNull();
    expect(niveau(w.x, dagen[0], 'ND')).toBe('ABSOLUUT');

    const echt = await importeer(rows, true);
    expect(echt.json.data.wijzigingen).toEqual(check.json.data.wijzigingen);
    expect(echt.json.data.toegepast).toBe(true);
    expect(niveau(w.y, ANDERE_UD, 'UD')).toBe('LIEVER_NIET');
    expect(loadAiosRedenen(w.y, w.period)).toEqual([{ datum: ANDERE_UD, tekst: 'kind naar de dokter' }]);
    for (const d of dagen) expect(niveau(w.x, d, 'ND')).toBeNull();
    expect(loadAiosRedenen(w.x, w.period)).toEqual([{ datum: UD_DAG, tekst: 'nieuwe cursus' }]);
    expect(niveau(w.z, WEEKEND_DD, 'DD')).toBe('VOORKEUR');
    // And it counts for the AIOS's hand-in: begun.
    expect(db.prepare('SELECT status FROM dienstrooster_submission WHERE person_id = ?').get(w.y)).toMatchObject({ status: 'BEZIG' });
  });

  it('no text after the colon takes the toelichting away', async () => {
    const rows = kopieer(await gelezen());
    rijen(rows, ANDERE_UD, 'UD')[0][kolom(rows, 'y')] = 'liever niet';
    const echt = await importeer(rows, true);
    expect(echt.json.data.wijzigingen).toEqual([{ codenaam: cn('y'), datum: ANDERE_UD, dienst: 'toelichting', van: 'kind naar de dokter', naar: 'leeg' }]);
    expect(loadAiosRedenen(w.y, w.period)).toEqual([]);
    expect(niveau(w.y, ANDERE_UD, 'UD')).toBe('LIEVER_NIET');
  });

  it("never touches leave: (afwezig) cells are skipped and an empty cell does not clear them", async () => {
    const rows = kopieer(await gelezen());
    const afwezig = rijen(rows, '2097-04-26', 'UD')[0];
    expect(afwezig[kolom(rows, 'y')]).toBe('geblokkeerd (afwezig)');
    afwezig[kolom(rows, 'y')] = '';
    const echt = await importeer(rows, true);
    expect(echt.json.data.problemen).toEqual([]);
    expect(niveau(w.y, '2097-04-26', 'UD')).toBe('ABSOLUUT');
  });
});

describe('a file with problems is refused whole', () => {
  it('says each, changes nothing, and applying is refused', async () => {
    const rows = kopieer(await gelezen());
    const voor = db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_availability').get() as { n: number };
    rows[0].push('onbekend-persoon');
    rows[0].push(cn('x')); // a column twice
    rijen(rows, ANDERE_UD, 'UD')[0][kolom(rows, 'z')] = 'misschien';
    rijen(rows, WEEKEND_DD, 'DD')[0][kolom(rows, 'z')] = 'voorkeur: omdat het kan';
    const check = await importeer(rows, false);
    const problemen: string[] = check.json.data.problemen;
    expect(problemen.some((p) => p.includes('onbekend-persoon') && p.includes('geen deelnemer'))).toBe(true);
    expect(problemen.some((p) => p.includes(cn('x')) && p.includes('twee keer'))).toBe(true);
    expect(problemen.some((p) => p.includes('"misschien"') && p.includes('geen geblokkeerd, liever niet of voorkeur'))).toBe(true);
    // A text after a voorkeur is read, but a day with only a voorkeur has no blokkade for it to stand with.
    expect(problemen.some((p) => p.includes(cn('z')) && p.includes(WEEKEND_DD) && p.includes('Kies eerst voor die dag geblokkeerd of liever niet'))).toBe(true);
    const echt = await importeer(rows, true);
    expect(echt.status).toBe(400);
    expect(echt.json.error.code).toBe('IMPORT_PROBLEMS');
    expect((db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_availability').get() as { n: number }).n).toBe(voor.n);
  });

  it("a codenaam of the achterwacht is as unknown as one that does not exist: the message does not tell it exists", async () => {
    const rows = kopieer(await gelezen());
    rows[0].push(staf.xCodenaam);
    rows[0].push('bestaat-niet-zeker');
    const problemen: string[] = (await importeer(rows, false)).json.data.problemen;
    const van = problemen.find((p) => p.includes(staf.xCodenaam))!;
    const onbekend = problemen.find((p) => p.includes('bestaat-niet-zeker'))!;
    expect(van).toBeDefined();
    expect(van.replace(staf.xCodenaam, 'NAAM')).toBe(onbekend.replace('bestaat-niet-zeker', 'NAAM'));
    expect(van).toContain('geen deelnemer');
    expect(van).not.toContain('doet niet mee');
  });

  it('a block is one choice: one dienst of it different from the rest is a problem', async () => {
    const rows = kopieer(await gelezen());
    const dagen = nachtDagen();
    // x has no night block marked any more (the test above emptied it): mark two of its three, not the third.
    rijen(rows, dagen[0], 'ND')[0][kolom(rows, 'x')] = 'geblokkeerd';
    rijen(rows, dagen[1], 'ND')[0][kolom(rows, 'x')] = 'geblokkeerd';
    const check = await importeer(rows, false);
    expect(check.json.data.problemen.some((p: string) => p.includes('past niet bij de rest van het blok'))).toBe(true);
    expect((await importeer(rows, true)).status).toBe(400);
    expect(niveau(w.x, dagen[0], 'ND')).toBeNull();
  });

  it('two different toelichtingen on one day are a problem', async () => {
    const rows = kopieer(await gelezen());
    const dagen = nachtDagen();
    for (const d of dagen) rijen(rows, d, 'ND')[0][kolom(rows, 'x')] = 'geblokkeerd: eerste';
    rijen(rows, dagen[0], 'UD')[0][kolom(rows, 'x')] = 'geblokkeerd: tweede';
    const check = await importeer(rows, false);
    expect(check.json.data.problemen.some((p: string) => p.includes('twee verschillende toelichtingen'))).toBe(true);
  });

  it('a block with a feestdag in it cannot be blocked, as on the AIOS screen', async () => {
    const rows = kopieer(await gelezen());
    const koningsdag = '2097-04-27';
    rijen(rows, koningsdag, 'DD')[0][kolom(rows, 'z')] = 'geblokkeerd';
    const check = await importeer(rows, false);
    expect(check.json.data.problemen.some((p: string) => p.includes('feestdag'))).toBe(true);
  });
});

describe('the toelichting of a day on every mark of that day', () => {
  it('a voorkeur of the day of a toelichting carries it too, and such an overview reads back unchanged', async () => {
    const v = insert('dienstrooster_person', { codenaam: cn('v'), rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: v, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    const dag = '2097-06-11';
    expect(setAiosVoorkeur(v, w.period, slotId(dag, 'UD'), 'LIEVER_NIET')).toEqual({ ok: true });
    expect(setAiosVoorkeur(v, w.period, slotId(dag, 'AD'), 'VOORKEUR')).toEqual({ ok: true });
    expect(saveAiosReden(v, loadAiosPeriode(w.period)!, dag, 'kind ziek')).toEqual({ ok: true });
    const rows = await gelezen();
    // The back-up holds every toelichting, after each mark of its day, a voorkeur included.
    expect(rijen(rows, dag, 'UD')[0][kolom(rows, 'v')]).toBe('liever niet: kind ziek');
    expect(rijen(rows, dag, 'AD')[0][kolom(rows, 'v')]).toBe('voorkeur: kind ziek');
    // The file as it was downloaded is accepted as it is: nothing changes, nothing is refused.
    const gecontroleerd = await importeer(rows, false);
    expect(gecontroleerd.status).toBe(200);
    expect(gecontroleerd.json.data).toMatchObject({ wijzigingen: [], problemen: [], toegepast: false });
    expect((await importeer(rows, true)).json.data).toMatchObject({ wijzigingen: [], problemen: [], toegepast: true });
    expect(loadAiosRedenen(v, w.period)).toEqual([{ datum: dag, tekst: 'kind ziek' }]);
  });

  it('not while a roster is being made: the generation read the preferences when it began', async () => {
    const opslag = globalThis as unknown as { __aiosGeneratieJobs?: Map<string, unknown> };
    const rows = await gelezen();
    opslag.__aiosGeneratieJobs!.set('loopt-import', { id: 'loopt-import', periodId: w.period, status: 'BEZIG', gestart: Date.now() });
    try {
      for (const toepassen of [false, true]) {
        const res = await importeer(rows, toepassen);
        expect(res.status).toBe(409);
        expect(res.json.error.code).toBe('GENERATION_RUNNING');
      }
    } finally {
      opslag.__aiosGeneratieJobs!.delete('loopt-import');
    }
    expect((await importeer(rows, false)).status).toBe(200);
  });
});

describe('what the import used to pass over in silence', () => {
  it('a column without a name but with data is a problem, one without data is not', async () => {
    const rows = kopieer(await gelezen());
    const n = rows[0].length;
    rows[0][n] = '';
    rijen(rows, UD_DAG, 'UD')[0][n] = 'iets';
    const check = await importeer(rows, false);
    expect((check.json.data.problemen as string[]).some((p) => p.includes(`Kolom ${n + 1} heeft geen kop maar wel gegevens`))).toBe(true);
    const leeg = kopieer(await gelezen());
    leeg[0][n] = '';
    expect((await importeer(leeg, false)).json.data.problemen).toEqual([]);
  });

  it('a toelichting on a part-time day or an absence is a problem, not thrown away', async () => {
    const rows = kopieer(await gelezen());
    const cel = rijen(rows, '2097-04-26', 'UD')[0];
    expect(cel[kolom(rows, 'y')]).toContain('(afwezig)');
    cel[kolom(rows, 'y')] = 'liever niet: toch niet weg';
    const check = await importeer(rows, false);
    expect((check.json.data.problemen as string[]).some((p) => p.includes(cn('y')) && p.includes('een toelichting kan niet bij een parttimedag of afwezigheid'))).toBe(true);
  });

  it('a block set from one dienst also changes the others of it: the check says so, as applying does', async () => {
    const s = insert('dienstrooster_person', { codenaam: cn('s'), rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: s, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    const dagen = nachtDagen().slice(0, 3);
    expect(setAiosVoorkeur(s, w.period, slotId(dagen[0], 'ND'), 'ABSOLUUT')).toEqual({ ok: true });
    const rows = kopieer(await gelezen());
    const k = kolom(rows, 's');
    // The file names the first night only; the other two rows are gone from it.
    const weg = new Set([dagen[1], dagen[2]].map((d) => rijen(rows, d, 'ND')[0]));
    const kleiner = rows.filter((r) => !weg.has(r));
    rijen(kleiner, dagen[0], 'ND')[0][k] = 'liever niet';
    const check = await importeer(kleiner, false);
    expect(check.json.data.problemen).toEqual([]);
    const van = (check.json.data.wijzigingen as Array<{ codenaam: string; dienst: string }>).filter((x) => x.codenaam === cn('s'));
    expect(van).toHaveLength(3);
    expect(van.filter((x) => x.dienst.includes('rest van het blok'))).toHaveLength(2);
    const echt = await importeer(kleiner, true);
    expect(echt.json.data.wijzigingen).toEqual(check.json.data.wijzigingen);
    for (const d of dagen) expect(niveau(s, d, 'ND')).toBe('LIEVER_NIET');
  });
});


describe('the requests of the AIOS at the top of the overview', () => {
  const nl = (iso: string) => `${iso.slice(8)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
  // A cell past the end of a row is not in it (the reader leaves out the empty ones at the end): filled before it is set.
  const verzoekRij = (rows: string[][], label: string) => {
    const rij = rows.find((r) => r[3] === label)!;
    for (let i = 0; i < rows[0].length; i++) rij[i] ??= '';
    return rij;
  };

  it('are in the file, one row each, and such a file reads back unchanged', async () => {
    const periode = loadAiosPeriode(w.period)!;
    expect(saveAiosWens(w.x, periode, { vier_nachten: true, inwerken_van: q.start_datum, inwerken_tot: '2097-04-30' })).toEqual({ ok: true });
    const rows = await gelezen();
    expect(rows.slice(1, 6).map((r) => r[3])).toEqual([
      'Verzoek: 4 avonden (wo t/m za)',
      'Verzoek: 4 nachten (wo t/m za)',
      'Verzoek: twee dagdiensten (za en zo)',
      'Verzoek: inwerken',
      'Verzoek: onderbreking van de opleiding',
    ]);
    expect(verzoekRij(rows, 'Verzoek: 4 nachten (wo t/m za)')[kolom(rows, 'x')]).toBe('ja');
    expect(verzoekRij(rows, 'Verzoek: 4 avonden (wo t/m za)')[kolom(rows, 'x')]).toBe('');
    expect(verzoekRij(rows, 'Verzoek: inwerken')[kolom(rows, 'x')]).toBe(`${nl(q.start_datum)} t/m 30-04-2097`);
    const echt = await importeer(rows, true);
    expect(echt.json.data).toMatchObject({ wijzigingen: [], problemen: [], toegepast: true });
  });

  it('a changed cell sets the request, an emptied one takes it away; checking says what applying does', async () => {
    const rows = kopieer(await gelezen());
    verzoekRij(rows, 'Verzoek: 4 avonden (wo t/m za)')[kolom(rows, 'y')] = 'Ja';
    verzoekRij(rows, 'Verzoek: 4 nachten (wo t/m za)')[kolom(rows, 'x')] = '';
    verzoekRij(rows, 'Verzoek: inwerken')[kolom(rows, 'x')] = `${nl(q.start_datum)} t/m 15-04-2097`;
    verzoekRij(rows, 'Verzoek: onderbreking van de opleiding')[kolom(rows, 'z')] = '10-05-2097 t/m 20-05-2097';
    const check = await importeer(rows, false);
    expect(check.json.data.problemen).toEqual([]);
    expect(loadAiosWens(w.y, w.period).vier_avonden).toBe(false);
    const echt = await importeer(rows, true);
    expect(echt.json.data.wijzigingen).toEqual(check.json.data.wijzigingen);
    expect(echt.json.data.wijzigingen).toEqual(
      expect.arrayContaining([
        { codenaam: cn('y'), datum: '', dienst: 'verzoek: 4 avonden (wo t/m za)', van: 'leeg', naar: 'ja' },
        { codenaam: cn('x'), datum: '', dienst: 'verzoek: 4 nachten (wo t/m za)', van: 'ja', naar: 'leeg' },
        { codenaam: cn('x'), datum: '', dienst: 'verzoek: inwerken', van: `${nl(q.start_datum)} t/m 30-04-2097`, naar: `${nl(q.start_datum)} t/m 15-04-2097` },
        { codenaam: cn('z'), datum: '', dienst: 'verzoek: onderbreking van de opleiding', van: 'leeg', naar: '10-05-2097 t/m 20-05-2097' },
      ])
    );
    expect(loadAiosWens(w.y, w.period).vier_avonden).toBe(true);
    expect(loadAiosWens(w.x, w.period)).toMatchObject({ vier_nachten: false, inwerken_van: q.start_datum, inwerken_tot: '2097-04-15' });
    expect(loadAiosWens(w.z, w.period)).toMatchObject({ onderbreking_van: '2097-05-10', onderbreking_tot: '2097-05-20' });
  });

  it('a file without those rows (from before) touches no request', async () => {
    const voor = [w.x, w.y, w.z].map((id) => loadAiosWens(id, w.period));
    const rows = kopieer(await gelezen()).filter((r) => !String(r[3]).startsWith('Verzoek:') && !String(r[3]).startsWith('Parttime'));
    const echt = await importeer(rows, true);
    expect(echt.json.data).toMatchObject({ wijzigingen: [], problemen: [] });
    expect([w.x, w.y, w.z].map((id) => loadAiosWens(id, w.period))).toEqual(voor);
  });

  it('a cell that is not ja, a period that cannot be read, one outside the quarter or an unknown request is a problem', async () => {
    const rows = kopieer(await gelezen());
    verzoekRij(rows, 'Verzoek: 4 nachten (wo t/m za)')[kolom(rows, 'y')] = 'misschien';
    verzoekRij(rows, 'Verzoek: inwerken')[kolom(rows, 'z')] = 'in mei';
    verzoekRij(rows, 'Verzoek: onderbreking van de opleiding')[kolom(rows, 'y')] = `01-01-2097 t/m 30-04-2097`;
    const onbekend = [...verzoekRij(rows, 'Verzoek: inwerken')];
    onbekend[3] = 'Verzoek: iets anders';
    rows.splice(2, 0, onbekend);
    const check = await importeer(rows, false);
    const problemen: string[] = check.json.data.problemen;
    expect(problemen.some((p) => p.includes('"misschien" is geen ja'))).toBe(true);
    expect(problemen.some((p) => p.includes('"in mei" is geen periode'))).toBe(true);
    expect(problemen.some((p) => p.includes('binnen het kwartaal'))).toBe(true);
    expect(problemen.some((p) => p.includes('"Verzoek: iets anders" is geen verzoek dat bekend is'))).toBe(true);
    expect((await importeer(rows, true)).status).toBe(400);
  });
});

describe('the part-time days at the top of the overview', () => {
  const alleen = (rows: string[][], label: string) => {
    const rij = rows.find((r) => r[3] === label)!;
    for (let i = 0; i < rows[0].length; i++) rij[i] ??= '';
    return rij;
  };
  const patronen = (wie: string) =>
    db.prepare('SELECT weekdag, frequentie FROM dienstrooster_parttime_pattern WHERE person_id = ? ORDER BY weekdag, frequentie').all(wie);

  it('are two rows, the AIOS in the column: a day in words, even weeks after a comma', async () => {
    for (const body of [
      { weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: q.start_datum, geldig_tot: q.eind_datum },
      { weekdag: 'DI', frequentie: 'EVEN_WEKEN', geldig_vanaf: q.start_datum, geldig_tot: q.eind_datum },
    ]) expect(voegPatroonToe(w.x, body).status).toBe(201);
    const rows = await gelezen();
    expect(alleen(rows, 'Parttime 1')[kolom(rows, 'x')]).toBe('maandag');
    expect(alleen(rows, 'Parttime 2')[kolom(rows, 'x')]).toBe('dinsdag, even weken');
    expect(alleen(rows, 'Parttime 1')[kolom(rows, 'y')]).toBe('');
    // Read back: nothing changes, and the marks the days make are skipped as (parttime).
    const echt = await importeer(rows, true);
    expect(echt.json.data).toMatchObject({ wijzigingen: [], problemen: [], toegepast: true });
    expect(patronen(w.x)).toHaveLength(2);
  });

  it('are added for an AIOS who has none yet, and their marks follow; checking says what applying does', async () => {
    const rows = kopieer(await gelezen());
    alleen(rows, 'Parttime 1')[kolom(rows, 'z')] = 'woensdag';
    alleen(rows, 'Parttime 2')[kolom(rows, 'z')] = 'vrijdag, oneven weken';
    const check = await importeer(rows, false);
    expect(check.json.data.problemen).toEqual([]);
    expect(patronen(w.z)).toHaveLength(0);
    const echt = await importeer(rows, true);
    expect(echt.json.data.wijzigingen).toEqual(check.json.data.wijzigingen);
    expect(echt.json.data.wijzigingen).toEqual(
      expect.arrayContaining([
        { codenaam: cn('z'), datum: '', dienst: 'parttimedag', van: 'leeg', naar: 'woensdag' },
        { codenaam: cn('z'), datum: '', dienst: 'parttimedag', van: 'leeg', naar: 'vrijdag, oneven weken' },
      ])
    );
    expect(patronen(w.z)).toEqual([
      { weekdag: 'VR', frequentie: 'ONEVEN_WEKEN' },
      { weekdag: 'WO', frequentie: 'ELKE_WEEK' },
    ]);
    // The part-time day sets its own marks: every Wednesday's uitloopdienst is blocked, by the part-time day.
    const uds = db
      .prepare(
        `SELECT sl.datum, av.blocking_level AS level, av.source AS bron FROM dienstrooster_shift_slot sl
         JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
         LEFT JOIN dienstrooster_availability av ON av.slot_id = sl.id AND av.person_id = ?
         WHERE sl.period_id = ? AND st.code = 'UD'`
      )
      .all(w.z, w.period) as Array<{ datum: string; level: string | null; bron: string | null }>;
    const woensdagen = uds.filter((r) => new Date(`${r.datum}T12:00:00Z`).getUTCDay() === 3);
    expect(woensdagen.length).toBeGreaterThan(5);
    expect(woensdagen.every((r) => r.level === 'ABSOLUUT' && r.bron === 'PARTTIME')).toBe(true);
  });

  it('other part-time days already there are a problem, and nothing is removed or changed', async () => {
    const voor = patronen(w.x);
    const rows = kopieer(await gelezen());
    alleen(rows, 'Parttime 1')[kolom(rows, 'x')] = 'donderdag';
    alleen(rows, 'Parttime 2')[kolom(rows, 'x')] = '';
    const check = await importeer(rows, false);
    expect(check.json.data.problemen.some((p: string) => p.includes(cn('x')) && p.includes('heeft al andere parttimedagen'))).toBe(true);
    expect((await importeer(rows, true)).status).toBe(400);
    expect(patronen(w.x)).toEqual(voor);
  });

  it('a cell that is not a day Monday to Friday is a problem; a file without the rows touches no part-time day', async () => {
    const rows = kopieer(await gelezen());
    alleen(rows, 'Parttime 1')[kolom(rows, 'y')] = 'zaterdag';
    const check = await importeer(rows, false);
    expect(check.json.data.problemen.some((p: string) => p.includes('"zaterdag" is geen parttimedag'))).toBe(true);

    const voor = [w.x, w.y, w.z].map(patronen);
    const zonder = kopieer(await gelezen()).filter((r) => !String(r[3]).startsWith('Parttime'));
    expect((await importeer(zonder, true)).json.data).toMatchObject({ wijzigingen: [], problemen: [] });
    expect([w.x, w.y, w.z].map(patronen)).toEqual(voor);
  });
});
