import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { setAiosVoorkeur } from '@/lib/aiosPreferences';
import { REDEN_MAX_LENGTH } from '@/lib/aiosVoorkeur';
import { readFirstSheet } from '@/lib/xlsx';
import { excelSerialToDate } from '@/lib/isoDate';
import { PUT as reden } from './deelnemer/[id]/periode/[periodId]/reden/route';
import { GET as scherm } from './deelnemer/[id]/periode/[periodId]/route';
import { GET as voorkeuren } from './periode/[id]/download-voorkeuren/route';
import { buildWorld, deleteRowsAfter, insert, now, personCookie, rowidSnapshot, staff, staffCookie, tag, type World } from '../../../tests/fixtures/dienstWorlds';

/**
 * The toelichting bij een dag (lib/aiosReden.ts), optional, private:
 * - saved per day, only for a day the AIOS marked geblokkeerd or liever
 *   niet by hand; empty takes it away; at most REDEN_MAX_LENGTH characters;
 *   only the AIOS's own (or their planner's), and only while the period
 *   takes input;
 * - a cleared mark takes its toelichting with it, and none is shown for a
 *   day without such a mark;
 * - the AIOS sees their own, never another's; the planner reads them in the
 *   voorkeurenoverzicht, after the mark ("geblokkeerd: ...");
 * - the planner's candidates for a hand correction carry them
 *   (aiosHandmatig.test.ts) and a swap never does (aiosRuilen.test.ts).
 */

let snapshot: Map<string, number>;
let staf: World;
const w = {} as { pool: string; period: string; planner: string; x: string; y: string };
const q = aiosQuarter(2097, 2);
const cn = (n: string) => `aiosrd-${n}-${tag}`;

const ctx = (id: string) => ({ params: Promise.resolve({ id, periodId: w.period }) });
const put = (van: string, als: string, body: unknown) =>
  reden(
    new NextRequest(`http://localhost/api/aios/deelnemer/${van}/periode/${w.period}/reden`, {
      method: 'PUT',
      headers: { cookie: personCookie(als), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx(van)
  );
const eigenScherm = async (wie: string) =>
  (
    await (
      await scherm(new NextRequest(`http://localhost/api/aios/deelnemer/${wie}/periode/${w.period}`, { headers: { cookie: personCookie(wie) } }), ctx(wie))
    ).json()
  ).data;

const slotOp = (code: string, datum: string) =>
  (
    db
      .prepare(
        `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
         WHERE sl.period_id = ? AND st.code = ? AND sl.datum = ?`
      )
      .get(w.period, code, datum) as { id: string }
  ).id;

const DAG = '2097-05-14'; // a Tuesday in the quarter
const ANDERE_DAG = '2097-05-15';

beforeAll(() => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosRd-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosRd-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  w.period = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `AiosRd-${tag}`,
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
    insert('dienstrooster_person_access_link', { person_id: id, token_hash: `aiosrd-${n}-${tag}`, aangemaakt_op: now });
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
});

afterAll(() => deleteRowsAfter(snapshot));

describe('saving the toelichting of a day', () => {
  it('only for a day marked geblokkeerd or liever niet by hand', async () => {
    const zonder = await put(w.x, w.x, { datum: DAG, tekst: 'ik ben weg' });
    expect(zonder.status).toBe(409);
    expect((await zonder.json()).error.code).toBe('GEEN_MARKERING');
    // Voorkeur is not "geen dienst of liever geen dienst".
    expect(setAiosVoorkeur(w.x, w.period, slotOp('UD', DAG), 'VOORKEUR')).toEqual({ ok: true });
    expect((await put(w.x, w.x, { datum: DAG, tekst: 'ik ben weg' })).status).toBe(409);
    expect(setAiosVoorkeur(w.x, w.period, slotOp('UD', DAG), 'LIEVER_NIET')).toEqual({ ok: true });
    const res = await put(w.x, w.x, { datum: DAG, tekst: '  ik ben weg  ' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.redenen).toEqual([{ datum: DAG, tekst: 'ik ben weg' }]);
  });

  it('is replaced by a new one, and taken away by an empty one', async () => {
    expect((await put(w.x, w.x, { datum: DAG, tekst: 'cursus' })).status).toBe(200);
    expect((await eigenScherm(w.x)).redenen).toEqual([{ datum: DAG, tekst: 'cursus' }]);
    const leeg = await put(w.x, w.x, { datum: DAG, tekst: '   ' });
    expect(leeg.status).toBe(200);
    expect((await leeg.json()).data.redenen).toEqual([]);
  });

  it('a date inside the quarter, text that is text, at most REDEN_MAX_LENGTH characters', async () => {
    expect((await put(w.x, w.x, { datum: '2097-12-31', tekst: 'a' })).status).toBe(400);
    expect((await put(w.x, w.x, { datum: 'morgen', tekst: 'a' })).status).toBe(400);
    expect((await put(w.x, w.x, { datum: DAG, tekst: 5 })).status).toBe(400);
    const te_lang = await put(w.x, w.x, { datum: DAG, tekst: 'a'.repeat(REDEN_MAX_LENGTH + 1) });
    expect(te_lang.status).toBe(400);
    expect((await te_lang.json()).error.message).toContain(String(REDEN_MAX_LENGTH));
    expect((await put(w.x, w.x, { datum: DAG, tekst: 'a'.repeat(REDEN_MAX_LENGTH) })).status).toBe(200);
  });

  it("is the AIOS's own: another AIOS cannot write it, the achterwacht's planner neither", async () => {
    expect((await put(w.x, w.y, { datum: DAG, tekst: 'van y' })).status).toBe(403);
    const stafRes = await reden(
      new NextRequest(`http://localhost/api/aios/deelnemer/${w.x}/periode/${w.period}/reden`, {
        method: 'PUT',
        headers: { cookie: staffCookie(staf.planner), 'content-type': 'application/json' },
        body: JSON.stringify({ datum: DAG, tekst: 'van de achterwacht' }),
      }),
      ctx(w.x)
    );
    expect(stafRes.status).toBeGreaterThanOrEqual(400);
    expect((await eigenScherm(w.x)).redenen.map((r: any) => r.tekst)).not.toContain('van y');
  });

  it('not after the period closed', async () => {
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GESLOTEN' WHERE id = ?`).run(w.period);
    try {
      expect((await put(w.x, w.x, { datum: DAG, tekst: 'te laat' })).status).toBe(403);
    } finally {
      db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'OPEN' WHERE id = ?`).run(w.period);
    }
  });
});

describe('who sees it', () => {
  it("the AIOS their own, never another AIOS's", async () => {
    expect((await eigenScherm(w.x)).redenen).toEqual([{ datum: DAG, tekst: 'a'.repeat(REDEN_MAX_LENGTH) }]);
    expect((await eigenScherm(w.y)).redenen).toEqual([]);
  });

  it('the planner, in the voorkeurenoverzicht after the mark, on each dienst of the day', async () => {
    expect((await put(w.x, w.x, { datum: DAG, tekst: 'cursus in Utrecht' })).status).toBe(200);
    const res = await voorkeuren(
      new NextRequest(`http://localhost/api/aios/periode/${w.period}/download-voorkeuren`, { headers: { cookie: staffCookie(w.planner) } }),
      { params: Promise.resolve({ id: w.period }) }
    );
    const rows = readFirstSheet(Buffer.from(await res.arrayBuffer()));
    const kolom = rows[0].indexOf(cn('x'));
    const opDag = rows.slice(1).filter((r) => excelSerialToDate(Number(r[0])) === DAG);
    const udRij = opDag.find((r) => r[3].startsWith('UD'))!;
    expect(udRij[kolom]).toBe('liever niet: cursus in Utrecht');
    // A dienst of that day without a mark of its own stays empty: the toelichting is of the day, shown where the mark is.
    expect(opDag.filter((r) => r[kolom]).every((r) => r[kolom].startsWith('liever niet: '))).toBe(true);
    // Nobody else's column, no other day.
    expect(rows.slice(1).filter((r) => r[rows[0].indexOf(cn('y'))]).length).toBe(0);
    expect(rows.slice(1).filter((r) => String(r[kolom] ?? '').includes('cursus')).length).toBe(opDag.filter((r) => r[kolom]).length);
  });
});

describe('a mark that goes takes the toelichting with it', () => {
  it('cleared: not on the screen, not in the table, not in the overview', async () => {
    expect(setAiosVoorkeur(w.x, w.period, slotOp('UD', DAG), null)).toEqual({ ok: true });
    expect((await eigenScherm(w.x)).redenen).toEqual([]);
    expect(db.prepare('SELECT 1 FROM dienstrooster_aios_reden WHERE person_id = ?').get(w.x)).toBeUndefined();
  });

  it('and one left behind is never shown', async () => {
    expect(setAiosVoorkeur(w.x, w.period, slotOp('UD', ANDERE_DAG), 'ABSOLUUT')).toEqual({ ok: true });
    expect((await put(w.x, w.x, { datum: ANDERE_DAG, tekst: 'blijft hangen' })).status).toBe(200);
    // The mark goes by another way than the AIOS's own screen: the row stays, the reading drops it.
    db.prepare(`DELETE FROM dienstrooster_availability WHERE person_id = ?`).run(w.x);
    expect(db.prepare('SELECT 1 FROM dienstrooster_aios_reden WHERE person_id = ?').get(w.x)).toBeDefined();
    expect((await eigenScherm(w.x)).redenen).toEqual([]);
  });
});
