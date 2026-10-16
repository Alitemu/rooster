import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { setAiosVoorkeur } from '@/lib/aiosPreferences';
import { laadAiosRooster } from '@/lib/aiosRooster';
import { aiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { GET as kandidaten } from './periode/[id]/rooster/kandidaten/route';
import { POST as wijzigen } from './periode/[id]/rooster/wijzigen/route';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, staff, staffCookie, tag, type World } from '../../../tests/fixtures/dienstWorlds';

/**
 * Changing the AIOS roster by hand (lib/aiosHandmatig.ts, step 4c):
 * - only a made roster, nothing being made meanwhile;
 * - per AIOS before choosing: who has it now, who can't (not in the pool
 *   that day) and what it would cost: the hard rules it adds (the app's copy,
 *   lib/aiosRegels.ts), their marks, the block no longer whole, above 25%;
 * - the change itself: one dienst or a block's diensten, only when each still
 *   has who the planner saw, written as MANUAL with assignment_edit rows and
 *   an audit row, its warnings and the way back;
 * - the roster lists what it breaks after a change by hand;
 * - the AIOS's planner's only.
 */

let snapshot: Map<string, number>;
let staf: World;
const w = {} as { pool: string; period: string; planner: string; x: string; y: string; z: string };
// A quarter of 13 weeks from a Wednesday, no feestdagen in it: 65 werkdagen.
const START = '2094-07-07';
const EIND = '2094-10-05';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const vraag = (dienst: string, heel: boolean, cookie = staffCookie(w.planner)) =>
  kandidaten(
    new NextRequest(`http://localhost/api/aios/periode/${w.period}/rooster/kandidaten?dienst=${dienst}&heel=${heel ? 1 : 0}`, { headers: { cookie } }),
    ctx(w.period)
  );
const zet = (wijzigingen: unknown, cookie = staffCookie(w.planner)) =>
  wijzigen(
    new NextRequest(`http://localhost/api/aios/periode/${w.period}/rooster/wijzigen`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ wijzigingen }),
    }),
    ctx(w.period)
  );

/** The dienst of this code on this day, and its block. */
const slot = (code: string, datum: string) =>
  db
    .prepare(
      `SELECT sl.id, sl.shift_block_id AS blok FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND st.code = ? AND sl.datum = ?`
    )
    .get(w.period, code, datum) as { id: string; blok: string | null };
const blokDiensten = (blok: string) =>
  (db.prepare('SELECT id FROM dienstrooster_shift_slot WHERE shift_block_id = ? ORDER BY datum').all(blok) as Array<{ id: string }>).map((r) => r.id);
const wieHeeft = (slotId: string) =>
  (db.prepare('SELECT person_id FROM dienstrooster_assignment WHERE slot_id = ?').get(slotId) as { person_id: string } | undefined)?.person_id ?? null;
const geef = (slotId: string, personId: string) =>
  insert('dienstrooster_assignment', { schedule_version_id: w.period, person_id: personId, slot_id: slotId, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });

beforeAll(() => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosHand-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosHand-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  w.period = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `AiosHand-${tag}`,
    start_datum: START,
    eind_datum: EIND,
    deadline: '2094-05-01T17:00',
    status: 'OPEN',
    auto_herinneren: 0,
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(w.period, aiosShiftTypes(w.pool)!, START, EIND))();
  const deelnemer = (n: string, tot = '2099-12-31') => {
    const id = insert('dienstrooster_person', { codenaam: `aioshand-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: tot });
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
  // z leaves the pool after the first week.
  w.z = deelnemer('z', '2094-07-13');
  // x part-time on Mondays: not fulltime.
  insert('dienstrooster_parttime_pattern', { person_id: w.x, weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31', aangemaakt_door: w.x, aangemaakt_op: now });
  // y: liever niet on the Saturday dagdienst of week 2, the first night block geblokkeerd.
  expect(setAiosVoorkeur(w.y, w.period, slot('DD', '2094-07-17').id, 'LIEVER_NIET')).toEqual({ ok: true });
  expect(setAiosVoorkeur(w.y, w.period, slot('ND', '2094-07-14').id, 'ABSOLUUT')).toEqual({ ok: true });
  // The roster: the first night block zo t/m di (11 to 13 juli) to x, the first Saturday's dagdienst to y.
  for (const id of blokDiensten(slot('ND', '2094-07-11').blok!)) geef(id, w.x);
  geef(slot('DD', '2094-07-10').id, w.y);
  db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD' WHERE id = ?`).run(w.period);
});

afterAll(() => deleteRowsAfter(snapshot));

describe('before choosing', () => {
  it('per AIOS who has it, who cannot and what it would cost', async () => {
    const nacht = slot('ND', '2094-07-11');
    const res = await vraag(nacht.id, true);
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.diensten.map((d: any) => d.dienst_id)).toEqual(blokDiensten(nacht.blok!));
    expect(data.diensten.every((d: any) => d.aios_id === w.x)).toBe(true);
    const k = new Map(data.kandidaten.map((c: any) => [c.person_id, c]));
    // Who has it now changes nothing: no warnings.
    expect(k.get(w.x)).toMatchObject({ nu: true, kan: true, waarschuwingen: [] });
    // y is fulltime: the nachtblok zo t/m di is for part-timers (rule 5); and
    // y has the Saturday dagdienst of 10 juli, whose Monday after is a compensation day.
    expect((k.get(w.y) as any).waarschuwingen.map((x: any) => x.tekst)).toEqual([
      'Een fulltimer in het nachtblok zo t/m di.',
      'Een dienst op een compensatiedag.',
    ]);
    // z is in the pool till 13 juli: the block fits, but not the second week.
    expect(k.get(w.z)).toMatchObject({ kan: true });
    const later = (await (await vraag(slot('DD', '2094-07-17').id, false)).json()).data;
    const zLater = later.kandidaten.find((c: any) => c.person_id === w.z);
    expect(zLater).toMatchObject({ kan: false, reden: expect.stringMatching(/^Niet in de pool op za 17 jul/) });
    // Who can, first; without a warning before with.
    expect(later.kandidaten[later.kandidaten.length - 1].person_id).toBe(w.z);
  });

  it('the marks: liever niet and geblokkeerd as the AIOS marked them', async () => {
    const dd = (await (await vraag(slot('DD', '2094-07-17').id, false)).json()).data;
    expect(dd.kandidaten.find((c: any) => c.person_id === w.y).waarschuwingen).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'LIEVER_NIET', tekst: 'Liever niet op za 17 jul.' })])
    );
    const nacht = (await (await vraag(slot('ND', '2094-07-14').id, true)).json()).data;
    expect(nacht.kandidaten.find((c: any) => c.person_id === w.y).waarschuwingen.map((x: any) => x.code)).toContain('GEBLOKKEERD');
  });

  it('a compensation day, a block no longer whole, and above 25%', async () => {
    // y has the Saturday dagdienst of 10 juli: the Friday before is a compensation day.
    const vr = (await (await vraag(slot('AD', '2094-07-09').id, true)).json()).data;
    const y = vr.kandidaten.find((c: any) => c.person_id === w.y);
    expect(y.waarschuwingen.map((x: any) => x.code)).toContain('7_COMPENSATIEDAG');
    // One day of x's night block to y: the block is no longer whole.
    const dag = (await (await vraag(slot('ND', '2094-07-12').id, false)).json()).data;
    expect(dag.diensten).toHaveLength(1);
    expect(dag.kandidaten.find((c: any) => c.person_id === w.y).waarschuwingen.map((x: any) => x.code)).toContain('2_BLOK_HEEL');
    // x with the second night block too: 6 points in 65 werkdagen at 0,8 fte, under 25%.
    const tweede = (await (await vraag(slot('ND', '2094-07-18').id, true)).json()).data;
    const x = tweede.kandidaten.find((c: any) => c.person_id === w.x);
    expect(x.percentage_na).toBeCloseTo(6 / (65 * 0.8));
    expect(x.waarschuwingen.map((v: any) => v.code)).not.toContain('BOVEN_25');
  });

  it('above 25% after it: a warning', async () => {
    // x also every night of August: 31 points more.
    const augustus = (
      db
        .prepare(
          `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
           WHERE sl.period_id = ? AND st.code = 'ND' AND sl.datum BETWEEN '2094-08-01' AND '2094-08-31'`
        )
        .all(w.period) as Array<{ id: string }>
    ).map((r) => geef(r.id, w.x));
    try {
      const data = (await (await vraag(slot('DD', '2094-07-17').id, false)).json()).data;
      const x = data.kandidaten.find((c: any) => c.person_id === w.x);
      expect(x.percentage_na).toBeCloseTo((3 + 31 + 1) / (65 * 0.8));
      expect(x.waarschuwingen.find((v: any) => v.code === 'BOVEN_25').tekst).toBe('Dienstpercentage daarna 67,3%: boven 25%.');
    } finally {
      for (const id of augustus) db.prepare('DELETE FROM dienstrooster_assignment WHERE id = ?').run(id);
    }
  });

  it('a dienst of this period, a made roster', async () => {
    expect((await vraag('bestaat-niet', false)).status).toBe(400);
    expect((await vraag(slot('ND', '2094-07-11').id, true, staffCookie(staf.planner))).status).toBe(404);
  });
});

describe('the change', () => {
  it('a whole block to another AIOS, with its warnings and the way back', async () => {
    const blok = blokDiensten(slot('ND', '2094-07-11').blok!);
    const res = await zet(blok.map((id) => ({ dienst_id: id, aios_id: w.y, was: w.x })));
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    // y is fulltime, and has the Saturday dagdienst of 10 juli: the Monday after is its compensation day.
    expect(data.waarschuwingen.map((x: any) => x.code)).toEqual(['5_FULLTIME_NACHTBLOK', '7_COMPENSATIEDAG']);
    expect(blok.map(wieHeeft)).toEqual([w.y, w.y, w.y]);
    const bron = db.prepare(`SELECT DISTINCT bron FROM dienstrooster_assignment WHERE slot_id IN (${blok.map(() => '?').join(',')})`).all(...blok);
    expect(bron).toEqual([{ bron: 'MANUAL' }]);
    const edits = db
      .prepare(`SELECT edit_type, person_id FROM dienstrooster_assignment_edit WHERE periode_id = ? ORDER BY rowid`)
      .all(w.period) as Array<{ edit_type: string; person_id: string }>;
    expect(edits.filter((e) => e.edit_type === 'HANDMATIG_VERWIJDEREN' && e.person_id === w.x)).toHaveLength(3);
    expect(edits.filter((e) => e.edit_type === 'HANDMATIG_TOEWIJZEN' && e.person_id === w.y)).toHaveLength(3);
    const audit = db
      .prepare(`SELECT nieuw_json FROM dienstrooster_audit_log WHERE entiteit_id = ? AND nieuw_json LIKE '%met de hand%' ORDER BY rowid DESC`)
      .get(w.period) as { nieuw_json: string };
    expect(JSON.parse(audit.nieuw_json)).toMatchObject({ waarschuwingen: ['5_FULLTIME_NACHTBLOK', '7_COMPENSATIEDAG'] });

    // The way back: "Ongedaan maken".
    expect(data.terug).toEqual(blok.map((id) => ({ dienst_id: id, aios_id: w.x, was: w.y })));
    expect((await zet(data.terug)).status).toBe(200);
    expect(blok.map(wieHeeft)).toEqual([w.x, w.x, w.x]);
  });

  it('only when each dienst still has who the planner saw', async () => {
    const dd = slot('DD', '2094-07-10').id;
    const res = await zet([{ dienst_id: dd, aios_id: w.x, was: w.z }]);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/intussen veranderd/);
    expect(wieHeeft(dd)).toBe(w.y);
  });

  it('empty, and filled again', async () => {
    const dd = slot('DD', '2094-07-10').id;
    expect((await zet([{ dienst_id: dd, aios_id: null, was: w.y }])).status).toBe(200);
    expect(wieHeeft(dd)).toBeNull();
    expect(laadAiosRooster(aiosUitnodigPeriode(w.period)!).leeg).toBeGreaterThan(0);
    expect((await zet([{ dienst_id: dd, aios_id: w.y, was: null }])).status).toBe(200);
    expect(wieHeeft(dd)).toBe(w.y);
  });

  it('refuses who is not in the pool that day, or not taking part', async () => {
    const dd = slot('DD', '2094-07-17').id;
    const buiten = await zet([{ dienst_id: dd, aios_id: w.z, was: null }]);
    expect(buiten.status).toBe(400);
    expect((await buiten.json()).error.message).toMatch(/Niet in de pool op za 17 jul/);
    expect((await zet([{ dienst_id: dd, aios_id: staf.planner, was: null }])).status).toBe(400);
    expect(wieHeeft(dd)).toBeNull();
  });

  it('one dienst or the diensten of one block, of this period', async () => {
    const a = slot('DD', '2094-07-10').id;
    const b = slot('DD', '2094-07-11').id;
    const nacht = blokDiensten(slot('ND', '2094-07-11').blok!);
    const avond = blokDiensten(slot('ADW', '2094-07-11').blok!);
    for (const lijst of [
      [{ dienst_id: a, aios_id: w.x, was: w.y }, { dienst_id: b, aios_id: w.x, was: null }],
      [{ dienst_id: nacht[0], aios_id: w.y, was: w.x }, { dienst_id: avond[0], aios_id: w.y, was: null }],
      [{ dienst_id: a, aios_id: w.x, was: w.y }, { dienst_id: a, aios_id: w.x, was: w.y }],
      [{ dienst_id: 'bestaat-niet', aios_id: w.x, was: null }],
      [{ dienst_id: a, aios_id: 3, was: w.y }],
      [{ dienst_id: a, aios_id: w.x }],
      [],
      'alles',
    ]) {
      expect((await zet(lijst)).status, JSON.stringify(lijst)).toBe(400);
    }
    expect(wieHeeft(a)).toBe(w.y);
  });

  it('one day of a block: the block no longer whole, and the roster says so', async () => {
    const nacht = slot('ND', '2094-07-12').id;
    const res = await zet([{ dienst_id: nacht, aios_id: w.z, was: w.x }]);
    expect(res.status).toBe(200);
    expect((await res.json()).data.waarschuwingen.map((x: any) => x.code)).toContain('2_BLOK_HEEL');
    const rooster = laadAiosRooster(aiosUitnodigPeriode(w.period)!);
    expect(rooster.overtredingen.map((o) => o.regel)).toContain('2_BLOK_HEEL');
    expect(rooster.overtredingen.find((o) => o.regel === '2_BLOK_HEEL')!.tekst).toMatch(/^Het blok is niet meer heel/);
  });
});

describe('when', () => {
  it('only a made roster, and not while one is being made', async () => {
    const dd = slot('DD', '2094-07-10').id;
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GESLOTEN' WHERE id = ?`).run(w.period);
    expect((await zet([{ dienst_id: dd, aios_id: w.x, was: w.y }])).status).toBe(409);
    expect((await vraag(dd, false)).status).toBe(409);
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD' WHERE id = ?`).run(w.period);

    const opslag = globalThis as unknown as { __aiosGeneratieJobs?: Map<string, unknown> };
    opslag.__aiosGeneratieJobs!.set('loopt', { id: 'loopt', periodId: w.period, status: 'BEZIG', gestart: Date.now() });
    try {
      const res = await zet([{ dienst_id: dd, aios_id: w.x, was: w.y }]);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('GENERATION_RUNNING');
    } finally {
      opslag.__aiosGeneratieJobs!.delete('loopt');
    }
    expect(wieHeeft(dd)).toBe(w.y);
  });

  it("is the AIOS's planner's: the achterwacht's planner gets nothing", async () => {
    const dd = slot('DD', '2094-07-10').id;
    expect((await zet([{ dienst_id: dd, aios_id: w.x, was: w.y }], staffCookie(staf.planner))).status).toBe(404);
    expect(wieHeeft(dd)).toBe(w.y);
  });
});
