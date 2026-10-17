import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { addDays } from '@/lib/holidays';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, loadAiosDiensten, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { setAiosVoorkeur } from '@/lib/aiosPreferences';
import { syncAiosPeriode } from '@/lib/aiosSync';
import { aiosSolverInvoer } from '@/lib/aiosSolverInvoer';
import { aiosCompensatiedagen } from '@/lib/aiosRegels';
import { laadAiosRooster } from '@/lib/aiosRooster';
import { aiosRoosterPerDag } from '@/lib/aiosRoosterDownloads';
import { aiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { GET, PUT } from './periode/[id]/voortgangstoets/route';
import { GET as deelnemerPagina } from './deelnemer/[id]/periode/[periodId]/route';
import { aiosPersoonlijkeLink } from '@/lib/aiosUitnodigen';
import { deleteRowsAfter, insert, now, personCookie, rowidSnapshot, staff, staffCookie, tag } from '../../../tests/fixtures/dienstWorlds';

/**
 * The voortgangstoets (lib/aiosVoortgangstoets.ts, docs/aios-rooster.md
 * "Voortgangstoets"): no AIOS has the night before it, which goes out of the
 * quarter as soon as the planner saves the date, so the solver never gets
 * it; the roster and the download say "Fellow" there. The other nights of
 * its block stay one block for one AIOS, with the compensation days on the
 * two days after the last of them (zo and ma give di and wo). Another date
 * or none puts the night back, with the block's marks and the leave on it.
 * Until the roster is published; a date whose night is not in the quarter is
 * refused, and so is a body without a datum.
 */

let snapshot: Map<string, number>;
// The marks on the block's Monday and Tuesday nights, as the AIOS and their leave made them.
let marks: unknown[][];
const w = {} as { pool: string; period: string; planner: string; x: string; y: string; start: string; eind: string };
// The second week of 2097 Q3 (no feestdagen): the night block zo t/m di and the days after it.
const dag = (n: number) => addDays(w.start, n);
const ZO = 11;
const MA = 12;
const DI = 13;
const WO = 14;
const DO = 15;

const ctx = () => ({ params: Promise.resolve({ id: w.period }) });
const zet = (body: unknown) =>
  PUT(
    new NextRequest(`http://localhost/api/aios/periode/${w.period}/voortgangstoets`, {
      method: 'PUT',
      headers: { cookie: staffCookie(w.planner), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx()
  );
const haal = async () =>
  (await (await GET(new NextRequest(`http://localhost/api/aios/periode/${w.period}/voortgangstoets`, { headers: { cookie: staffCookie(w.planner) } }), ctx())).json()).data;

const nacht = (datum: string) =>
  db
    .prepare(
      `SELECT sl.id, sl.shift_block_id AS blok FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND sl.datum = ? AND st.code = 'ND'`
    )
    .get(w.period, datum) as { id: string; blok: string | null } | undefined;
const markeringen = (datum: string) =>
  db
    .prepare(
      `SELECT person_id, blocking_level, source FROM dienstrooster_availability WHERE slot_id = ? ORDER BY person_id`
    )
    .all(nacht(datum)!.id);
const zetStatus = (s: string) => db.prepare('UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?').run(s, w.period);
const periode = () => aiosUitnodigPeriode(w.period)!;

beforeAll(() => {
  snapshot = rowidSnapshot();
  w.planner = staff('PLANNER', 'AIOS');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosVt-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosVt-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  const q = aiosQuarter(2097, 3);
  w.start = q.start_datum;
  w.eind = q.eind_datum;
  w.period = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `AiosVt-${tag}`,
    start_datum: q.start_datum,
    eind_datum: q.eind_datum,
    deadline: '2097-05-01T17:00',
    status: 'OPEN',
    auto_herinneren: 0,
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(w.period, aiosShiftTypes(w.pool)!, q.start_datum, q.eind_datum))();
  const deelnemer = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: `aiosvt-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
  // x works part-time (the night block zo t/m di is for part-timers, hard
  // rule 5) and marks that block liever niet; y is away on its Monday and Tuesday.
  insert('dienstrooster_parttime_pattern', {
    person_id: w.x,
    weekdag: 'VR',
    frequentie: 'ELKE_WEEK',
    geldig_vanaf: '2090-01-01',
    geldig_tot: '2099-12-31',
    aangemaakt_door: w.planner,
    aangemaakt_op: now,
  });
  expect(setAiosVoorkeur(w.x, w.period, nacht(dag(ZO))!.id, 'LIEVER_NIET')).toEqual({ ok: true });
  insert('dienstrooster_absence', { person_id: w.y, van_datum: dag(MA), tot_datum: dag(DI), soort: 'VAKANTIE', aangemaakt_door: w.planner, aangemaakt_op: now });
  syncAiosPeriode(w.period);
  const verwacht = [
    { person_id: w.x, blocking_level: 'LIEVER_NIET', source: 'MANUAL' },
    { person_id: w.y, blocking_level: 'ABSOLUUT', source: 'ABSENCE' },
  ].sort((a, b) => a.person_id.localeCompare(b.person_id));
  marks = [verwacht, verwacht];
  expect([markeringen(dag(MA)), markeringen(dag(DI))]).toEqual(marks);
});

afterAll(() => {
  deleteRowsAfter(snapshot);
});

beforeEach(async () => {
  zetStatus('OPEN');
  db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(w.period);
  expect((await zet({ datum: null })).status).toBe(200);
});

describe('the voortgangstoets', () => {
  it('takes the night before out of the quarter, the solver never gets it and the screens say Fellow', async () => {
    const blok = nacht(dag(DI))!.blok;
    const res = await zet({ datum: dag(WO) });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ datum: dag(WO), nacht: dag(DI) });
    expect(nacht(dag(DI))).toBeUndefined();
    // The other two nights stay in their block.
    expect([nacht(dag(ZO))!.blok, nacht(dag(MA))!.blok]).toEqual([blok, blok]);
    expect(aiosSolverInvoer(periode(), 60).diensten.filter((d) => d.code === 'ND' && d.datum === dag(DI))).toEqual([]);
    const dagen = loadAiosDiensten(w.period, w.start, w.eind).dagen;
    expect(dagen.filter((d) => d.fellow_nacht).map((d) => d.datum)).toEqual([dag(DI)]);
    expect(await haal()).toMatchObject({ datum: dag(WO), nacht: dag(DI), mag_wijzigen: true });
    const audit = db
      .prepare(`SELECT nieuw_json FROM dienstrooster_audit_log WHERE entiteit_id = ? AND nieuw_json LIKE '%voortgangstoets AIOS%' ORDER BY rowid DESC LIMIT 1`)
      .get(w.period) as { nieuw_json: string };
    expect(JSON.parse(audit.nieuw_json).voortgangstoets).toBe(dag(WO));
  });

  it("gives the rest of the block the compensation days after its last night, a gap in it or not", async () => {
    const compensatie = (nachten: number[]) =>
      aiosCompensatiedagen(aiosSolverInvoer(periode(), 60), new Map(nachten.map((n) => [nacht(dag(n))!.id, w.x]))).get(w.x);
    expect(compensatie([ZO, MA, DI])).toEqual([dag(WO), dag(DO)]);
    // Toets on Wednesday: zo and ma, then di and wo (the planner's example).
    await zet({ datum: dag(WO) });
    expect(compensatie([ZO, MA])).toEqual([dag(DI), dag(WO)]);
    // Toets on Tuesday: zo and di with the fellow's Monday between, then wo and do.
    await zet({ datum: dag(DI) });
    expect(nacht(dag(MA))).toBeUndefined();
    expect(compensatie([ZO, DI])).toEqual([dag(WO), dag(DO)]);
  });

  it('puts the night back on another date or none, with the block marks and the leave on it', async () => {
    const blok = nacht(dag(DI))!.blok;
    await zet({ datum: dag(WO) });
    await zet({ datum: dag(DO) });
    expect(nacht(dag(WO))).toBeUndefined();
    expect(nacht(dag(DI))!.blok).toBe(blok);
    // The Monday's leave stays where it was too.
    expect([markeringen(dag(MA)), markeringen(dag(DI))]).toEqual(marks);
    expect((await zet({ datum: null })).status).toBe(200);
    expect(nacht(dag(WO))).toBeDefined();
    expect(await haal()).toMatchObject({ datum: null, nacht: null });
  });

  it('puts a night back open on a part-time day', async () => {
    // x is part-time on Fridays: the Friday night stays open for x (lib/aiosSync.ts).
    const vrijdag = dag(9);
    expect(markeringen(vrijdag)).toEqual([]);
    await zet({ datum: dag(10) });
    expect(nacht(vrijdag)).toBeUndefined();
    await zet({ datum: null });
    expect(markeringen(vrijdag)).toEqual([]);
  });

  it('refuses a night outside the quarter, no date and no datum at all', async () => {
    for (const datum of [w.start, addDays(w.eind, 2), '2097-09-31', 'morgen', 7]) {
      const res = await zet({ datum });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/voortgangstoets/);
    }
    expect((await zet({})).status).toBe(400);
    expect(await haal()).toMatchObject({ datum: null });
    // The last night of the quarter is in it: the toets on the Wednesday after.
    expect((await zet({ datum: addDays(w.eind, 1) })).status).toBe(200);
    expect(nacht(w.eind)).toBeUndefined();
  });

  it("tells the AIOS on their own page, where the night is not in the block", async () => {
    aiosPersoonlijkeLink(w.x, w.period, 'http://localhost:3000');
    const pagina = async () =>
      (
        await (
          await deelnemerPagina(new NextRequest(`http://localhost/api/aios/deelnemer/${w.x}/periode/${w.period}`, { headers: { cookie: personCookie(w.x) } }), {
            params: Promise.resolve({ id: w.x, periodId: w.period }),
          })
        ).json()
      ).data;
    expect((await pagina()).voortgangstoets).toEqual({ datum: null, nacht: null });
    await zet({ datum: dag(WO) });
    const data = await pagina();
    expect(data.voortgangstoets).toEqual({ datum: dag(WO), nacht: dag(DI) });
    expect(data.dagen.find((d: { datum: string }) => d.datum === dag(DI)).diensten.map((x: { code: string }) => x.code)).not.toContain('ND');
  });

  it('takes the night out of a roster already made, and fixes the date once it is published', async () => {
    for (const n of [ZO, MA, DI]) {
      insert('dienstrooster_assignment', { schedule_version_id: w.period, person_id: w.x, slot_id: nacht(dag(n))!.id, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
    }
    zetStatus('GEGENEREERD');
    expect((await zet({ datum: dag(WO) })).status).toBe(200);
    const rooster = laadAiosRooster(periode());
    expect(rooster.dagen.find((d) => d.datum === dag(DI))!.fellow_nacht).toBe(true);
    expect(rooster.overtredingen.filter((o) => o.wie.includes(`aiosvt-x-${tag}`))).toEqual([]);
    const rij = aiosRoosterPerDag(periode()).rows.find((r) => (r[0] as { date: string }).date === dag(DI))!;
    expect(rij[7]).toBe('Fellow');

    zetStatus('GEPUBLICEERD');
    expect(await haal()).toMatchObject({ mag_wijzigen: false });
    const res = await zet({ datum: null });
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain('ligt vast');
    expect(nacht(dag(DI))).toBeUndefined();
  });
  describe('the night that comes back, in a roster already made', () => {
    const blokAan = (wie: string[]) => {
      [ZO, MA, DI].forEach((n, i) =>
        insert('dienstrooster_assignment', { schedule_version_id: w.period, person_id: wie[i], slot_id: nacht(dag(n))!.id, bron: 'SOLVER', row_version: 1, aangemaakt_op: now })
      );
      zetStatus('GEGENEREERD');
    };
    const houder = (datum: string) =>
      (db.prepare('SELECT person_id FROM dienstrooster_assignment WHERE slot_id = ?').get(nacht(datum)!.id) as { person_id: string } | undefined)?.person_id ?? null;
    const terug = async (datum: string | null) => (await (await zet({ datum })).json()).data.teruggezet;

    it('goes to the AIOS of the rest of its block, so the block is whole again', async () => {
      blokAan([w.x, w.x, w.x]);
      expect(await terug(dag(WO))).toBeNull();
      expect(nacht(dag(DI))).toBeUndefined();
      // x marked the block liever niet: that is no reason to leave it open.
      expect(await terug(null)).toEqual({ nacht: dag(DI), aios_id: w.x, reden: null });
      expect([houder(dag(ZO)), houder(dag(MA)), houder(dag(DI))]).toEqual([w.x, w.x, w.x]);
      expect(laadAiosRooster(periode()).dagen.find((d) => d.datum === dag(DI))!.fellow_nacht).toBe(false);
    });

    it('also when the toets moves to another night of the same block', async () => {
      blokAan([w.x, w.x, w.x]);
      await zet({ datum: dag(WO) });
      expect(await terug(dag(DI))).toEqual({ nacht: dag(DI), aios_id: w.x, reden: null });
      expect(nacht(dag(MA))).toBeUndefined();
      expect([houder(dag(ZO)), houder(dag(DI))]).toEqual([w.x, w.x]);
    });

    it('stays open when that AIOS is away that night, and says why', async () => {
      // y is away on the Monday and Tuesday; the planner gave y the block anyway.
      blokAan([w.y, w.y, w.y]);
      await zet({ datum: dag(WO) });
      expect(await terug(null)).toEqual({ nacht: dag(DI), aios_id: null, reden: 'GEBLOKKEERD' });
      expect(houder(dag(DI))).toBeNull();
    });

    it('stays open when the rest of the block is not with one AIOS', async () => {
      blokAan([w.x, w.y, w.x]);
      await zet({ datum: dag(WO) });
      expect(await terug(null)).toEqual({ nacht: dag(DI), aios_id: null, reden: 'NIET_EEN_AIOS' });
      expect(houder(dag(DI))).toBeNull();
    });

    it('is nobody\'s before the roster is made', async () => {
      await zet({ datum: dag(WO) });
      expect(await terug(null)).toBeNull();
      expect(houder(dag(DI))).toBeNull();
    });
  });
});
