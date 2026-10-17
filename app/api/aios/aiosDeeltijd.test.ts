import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { aiosFte } from '@/lib/aiosFte';
import { aiosSolverInvoer } from '@/lib/aiosSolverInvoer';
import { aiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { GET as patronen, POST as nieuwPatroon } from './deelnemer/[id]/deeltijd/route';
import { PATCH as wijzigPatroon, DELETE as verwijderPatroon } from './deelnemer/[id]/deeltijd/[patternId]/route';
import { GET as afwezigheden, POST as nieuweAfwezigheid } from './deelnemer/[id]/afwezigheid/route';
import { PATCH as wijzigAfwezigheid, DELETE as verwijderAfwezigheid } from './deelnemer/[id]/afwezigheid/[absenceId]/route';
import { POST as indienen } from './deelnemer/[id]/periode/[periodId]/indienen/route';
import { deleteRowsAfter, insert, now, personCookie, rowidSnapshot, tag } from '../../../tests/fixtures/dienstWorlds';

/**
 * An AIOS's part-time days and leave on their own routes (lib/aiosDeeltijd.ts):
 * - only what makes sense is saved: a weekday, a known frequency and kind,
 *   real dates in order, a note of at most 1000 characters;
 * - one part-time day per weekday at a time: two patterns that share a day
 *   (every Monday and every other Monday) counted twice for the fte, which
 *   gave the AIOS fewer diensten for a day they were off once (the audit
 *   of the AIOS, 0.85.0). Even and odd weeks of one weekday share none;
 * - each AIOS changes and removes only their own: another's id answers 404
 *   and changes nothing;
 * - the marks move with a change: in a quarter that takes input the old
 *   days are free again and the new ones marked, in one past its deadline
 *   nothing moves, and the answer says so;
 * - handing in: one row per AIOS and quarter however often, not past the
 *   deadline, not in a quarter that is not theirs.
 *
 * 2097 Q2 runs from Wednesday 3 April to Tuesday 2 July 2097; 2097 Q1 is
 * past its deadline here.
 */

let snapshot: Map<string, number>;
const w = {} as { pool: string; open: string; dicht: string; x: string; y: string };
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });
const Q2 = aiosQuarter(2097, 2);
const Q1 = aiosQuarter(2097, 1);

const vraag = (url: string, method: string, persoon: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/aios/deelnemer/${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: personCookie(persoon) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** The PARTTIME or ABSENCE marks of one AIOS in one quarter, by date and dienst. */
const markeringen = (personId: string, periodId: string, bron: string) =>
  (
    db
      .prepare(
        `SELECT s.datum || ' ' || st.code AS d FROM dienstrooster_availability av
         JOIN dienstrooster_shift_slot s ON s.id = av.slot_id
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         WHERE av.person_id = ? AND s.period_id = ? AND av.source = ? ORDER BY s.datum, st.code`
      )
      .all(personId, periodId, bron) as Array<{ d: string }>
  ).map((r) => r.d);
const weekdagen = (lijst: string[]) => [...new Set(lijst.map((d) => new Date(`${d.slice(0, 10)}T12:00:00`).getDay()))];

const maakPatroon = async (persoon: string, body: Record<string, unknown>) => {
  const res = await nieuwPatroon(vraag(`${persoon}/deeltijd`, 'POST', persoon, body), ctx({ id: persoon }));
  return { status: res.status, json: await res.json() };
};
const maakAfwezigheid = async (persoon: string, body: Record<string, unknown>) => {
  const res = await nieuweAfwezigheid(vraag(`${persoon}/afwezigheid`, 'POST', persoon, body), ctx({ id: persoon }));
  return { status: res.status, json: await res.json() };
};
const aantal = (tabel: string, personId: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${tabel} WHERE person_id = ?`).get(personId) as { n: number }).n;

beforeAll(() => {
  snapshot = rowidSnapshot();
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosDt-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosDt-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  const periode = (q: typeof Q1, deadline: string) => {
    const id = insert('dienstrooster_schedule_period', {
      pool_id: w.pool,
      naam: `AiosDt ${q.kwartaal}-${tag}`,
      start_datum: q.start_datum,
      eind_datum: q.eind_datum,
      deadline,
      status: 'OPEN',
      auto_herinneren: 0,
      aangemaakt_op: now,
    });
    db.transaction(() => persistAiosSlots(id, aiosShiftTypes(w.pool)!, q.start_datum, q.eind_datum))();
    return id;
  };
  w.open = periode(Q2, '2097-02-05T17:00');
  w.dicht = periode(Q1, '2020-01-01T17:00');
  const aios = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: `aiosdt-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2096-01-01', geldig_tot: '2098-12-31' });
    insert('dienstrooster_person_access_link', { person_id: id, token_hash: `aiosdt-${n}-${tag}`, aangemaakt_op: now });
    return id;
  };
  w.x = aios('x');
  w.y = aios('y');
});

afterAll(() => deleteRowsAfter(snapshot));

describe("an AIOS's part-time days", () => {
  it('saves only a weekday, a known frequency and real dates in order', async () => {
    const goed = { weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2097-01-01', geldig_tot: '2097-12-31' };
    for (const fout of [
      { ...goed, weekdag: 'ZA' },
      { ...goed, weekdag: 'maandag' },
      { ...goed, frequentie: 'SOMS' },
      { ...goed, geldig_vanaf: '2097-02-30' },
      { ...goed, geldig_vanaf: '2097-12-31', geldig_tot: '2097-01-01' },
      { ...goed, geldig_tot: undefined },
    ]) {
      const res = await maakPatroon(w.y, fout);
      expect(res.status, JSON.stringify(fout)).toBe(400);
    }
    expect(aantal('dienstrooster_parttime_pattern', w.y)).toBe(0);
  });

  it('one part-time day per weekday at a time: a second one that shares a day is refused, even and odd weeks share none', async () => {
    const patroon = (weekdag: string, frequentie: string, van: string, tot: string) => maakPatroon(w.y, { weekdag, frequentie, geldig_vanaf: van, geldig_tot: tot });
    expect((await patroon('MA', 'EVEN_WEKEN', '2097-01-01', '2097-12-31')).status).toBe(201);
    for (const [frequentie, van, tot] of [
      ['ELKE_WEEK', '2097-05-01', '2097-12-31'],
      ['EVEN_WEKEN', '2097-06-01', '2098-06-30'],
    ]) {
      const res = await patroon('MA', frequentie, van, tot);
      expect(res.status, `${frequentie} ${van}`).toBe(409);
      expect(res.json.error.message).toMatch(/maandag/);
    }
    // Odd weeks: another Monday each time, together every Monday (from other
    // dates: the same weekday and dates twice is refused anyway).
    expect((await patroon('MA', 'ONEVEN_WEKEN', '2097-01-02', '2097-12-31')).status).toBe(201);
    // Another weekday, or the same one after the first ends.
    expect((await patroon('DO', 'ELKE_WEEK', '2097-01-01', '2097-12-31')).status).toBe(201);
    expect((await patroon('MA', 'ELKE_WEEK', '2098-01-01', '2098-12-31')).status).toBe(201);
    // Every Monday and every Thursday: two days a week off, counted once each.
    const ingevoerd = aiosSolverInvoer(aiosUitnodigPeriode(w.open)!, 60).aios.find((a) => a.id === w.y)!;
    expect(ingevoerd.fte).toBe(0.6);
    // Changing one into a clash is refused too, and leaves it as it was.
    const odd = db.prepare("SELECT id FROM dienstrooster_parttime_pattern WHERE person_id = ? AND frequentie = 'ONEVEN_WEKEN'").get(w.y) as { id: string };
    const res = await wijzigPatroon(vraag(`${w.y}/deeltijd/${odd.id}`, 'PATCH', w.y, { frequentie: 'EVEN_WEKEN' }), ctx({ id: w.y, patternId: odd.id }));
    expect(res.status).toBe(409);
    expect((db.prepare('SELECT frequentie FROM dienstrooster_parttime_pattern WHERE id = ?').get(odd.id) as { frequentie: string }).frequentie).toBe('ONEVEN_WEKEN');
    expect(aiosFte([{ frequentie: 'EVEN_WEKEN', geldig_vanaf: Q2.start_datum, geldig_tot: Q2.eind_datum }, { frequentie: 'ONEVEN_WEKEN', geldig_vanaf: Q2.start_datum, geldig_tot: Q2.eind_datum }], Q2.start_datum, Q2.eind_datum)).toBe(0.8);
  });

  it('moves the marks with a change: the old day free again, the new day marked, not in a quarter past its deadline', async () => {
    const res = await maakPatroon(w.x, { weekdag: 'DI', frequentie: 'ELKE_WEEK', geldig_vanaf: '2097-01-01', geldig_tot: '2097-12-31' });
    expect(res.status).toBe(201);
    // Past its deadline: the answer says so, and that quarter gets nothing.
    expect(res.json.data.warning).toMatch(/deadline al verstreken/);
    expect(markeringen(w.x, w.dicht, 'PARTTIME')).toEqual([]);
    expect(weekdagen(markeringen(w.x, w.open, 'PARTTIME'))).toEqual([2]);
    const id = res.json.data.id as string;
    const gewijzigd = await wijzigPatroon(vraag(`${w.x}/deeltijd/${id}`, 'PATCH', w.x, { weekdag: 'VR' }), ctx({ id: w.x, patternId: id }));
    expect(gewijzigd.status).toBe(200);
    expect(weekdagen(markeringen(w.x, w.open, 'PARTTIME'))).toEqual([5]);
    // Only the end moved: the pattern is no clash with itself.
    const korter = await wijzigPatroon(vraag(`${w.x}/deeltijd/${id}`, 'PATCH', w.x, { geldig_tot: '2097-05-31' }), ctx({ id: w.x, patternId: id }));
    expect(korter.status).toBe(200);
    expect(markeringen(w.x, w.open, 'PARTTIME').every((d) => d.slice(0, 10) <= '2097-05-31')).toBe(true);
    const weg = await verwijderPatroon(vraag(`${w.x}/deeltijd/${id}`, 'DELETE', w.x), ctx({ id: w.x, patternId: id }));
    expect(weg.status).toBe(200);
    expect(markeringen(w.x, w.open, 'PARTTIME')).toEqual([]);
  });

  it("changes and removes only their own: another AIOS's pattern answers 404 and stays", async () => {
    const van = (await maakPatroon(w.x, { weekdag: 'WO', frequentie: 'ELKE_WEEK', geldig_vanaf: '2097-01-01', geldig_tot: '2097-12-31' })).json.data.id as string;
    const voor = db.prepare('SELECT * FROM dienstrooster_parttime_pattern WHERE id = ?').get(van);
    const wijzig = await wijzigPatroon(vraag(`${w.y}/deeltijd/${van}`, 'PATCH', w.y, { weekdag: 'VR' }), ctx({ id: w.y, patternId: van }));
    const verwijder = await verwijderPatroon(vraag(`${w.y}/deeltijd/${van}`, 'DELETE', w.y), ctx({ id: w.y, patternId: van }));
    expect([wijzig.status, verwijder.status]).toEqual([404, 404]);
    expect(db.prepare('SELECT * FROM dienstrooster_parttime_pattern WHERE id = ?').get(van)).toEqual(voor);
    // Nor through their own url with x's id in it: the session is y's.
    const ander = await wijzigPatroon(vraag(`${w.x}/deeltijd/${van}`, 'PATCH', w.y, { weekdag: 'VR' }), ctx({ id: w.x, patternId: van }));
    expect(ander.status).toBe(403);
    const lijst = await (await patronen(vraag(`${w.y}/deeltijd`, 'GET', w.y), ctx({ id: w.y }))).json();
    expect(lijst.data.map((p: { id: string }) => p.id)).not.toContain(van);
  });
});

describe("an AIOS's leave", () => {
  it('saves only a known kind, real dates in order and a note of at most 1000 characters', async () => {
    const goed = { van_datum: '2097-05-06', tot_datum: '2097-05-08', soort: 'VAKANTIE' };
    for (const fout of [
      { ...goed, soort: 'ZIEK' },
      { ...goed, van_datum: '6 mei' },
      { ...goed, van_datum: '2097-05-09' },
      { ...goed, soort: undefined },
      { ...goed, notitie: 'x'.repeat(2001) },
    ]) {
      const res = await maakAfwezigheid(w.y, fout);
      expect(res.status, JSON.stringify(fout)).toBe(400);
    }
    expect(aantal('dienstrooster_absence', w.y)).toBe(0);
  });

  it('blocks its days in the open quarter, moves with a change and goes when removed', async () => {
    const res = await maakAfwezigheid(w.y, { van_datum: '2097-05-06', tot_datum: '2097-05-06', soort: 'CONGRES' });
    expect(res.status).toBe(201);
    const id = res.json.data.id as string;
    expect([...new Set(markeringen(w.y, w.open, 'ABSENCE').map((d) => d.slice(0, 10)))]).toEqual(['2097-05-06']);
    const gewijzigd = await wijzigAfwezigheid(
      vraag(`${w.y}/afwezigheid/${id}`, 'PATCH', w.y, { van_datum: '2097-05-13', tot_datum: '2097-05-14' }),
      ctx({ id: w.y, absenceId: id })
    );
    expect(gewijzigd.status).toBe(200);
    expect([...new Set(markeringen(w.y, w.open, 'ABSENCE').map((d) => d.slice(0, 10)))]).toEqual(['2097-05-13', '2097-05-14']);
    const lijst = await (await afwezigheden(vraag(`${w.y}/afwezigheid?period_id=${w.open}`, 'GET', w.y), ctx({ id: w.y }))).json();
    expect(lijst.data.find((a: { id: string }) => a.id === id)).toMatchObject({ total_days_in_period: 2, blocked_days_in_period: 2 });
    const weg = await verwijderAfwezigheid(vraag(`${w.y}/afwezigheid/${id}`, 'DELETE', w.y), ctx({ id: w.y, absenceId: id }));
    expect(weg.status).toBe(200);
    expect(markeringen(w.y, w.open, 'ABSENCE')).toEqual([]);
  });

  it("changes and removes only their own: another AIOS's leave answers 404 and stays", async () => {
    const van = (await maakAfwezigheid(w.x, { van_datum: '2097-06-03', tot_datum: '2097-06-04', soort: 'VAKANTIE' })).json.data.id as string;
    const voor = markeringen(w.x, w.open, 'ABSENCE');
    expect(voor.length).toBeGreaterThan(0);
    const wijzig = await wijzigAfwezigheid(vraag(`${w.y}/afwezigheid/${van}`, 'PATCH', w.y, { tot_datum: '2097-06-30' }), ctx({ id: w.y, absenceId: van }));
    const verwijder = await verwijderAfwezigheid(vraag(`${w.y}/afwezigheid/${van}`, 'DELETE', w.y), ctx({ id: w.y, absenceId: van }));
    expect([wijzig.status, verwijder.status]).toEqual([404, 404]);
    expect(markeringen(w.x, w.open, 'ABSENCE')).toEqual(voor);
  });
});

describe('handing in', () => {
  const geef = (persoon: string, periode: string, als = persoon) =>
    indienen(vraag(`${persoon}/periode/${periode}/indienen`, 'POST', als), ctx({ id: persoon, periodId: periode }));
  const rijen = (persoon: string, periode: string) =>
    db.prepare('SELECT status FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?').all(persoon, periode) as Array<{ status: string }>;

  it('one row per AIOS and quarter however often, not past the deadline, not in a quarter that is not theirs', async () => {
    expect((await geef(w.x, w.open)).status).toBe(200);
    expect((await geef(w.x, w.open)).status).toBe(200);
    expect(rijen(w.x, w.open)).toEqual([{ status: 'BEVESTIGD' }]);
    const laat = await geef(w.y, w.dicht);
    expect(laat.status).toBe(403);
    expect((await laat.json()).error.code).toBe('DEADLINE_PASSED');
    expect(rijen(w.y, w.dicht)).toEqual([]);
    // Another AIOS's hand-in: their session is not that AIOS's.
    expect((await geef(w.y, w.open, w.x)).status).toBe(403);
    expect(rijen(w.y, w.open).filter((r) => r.status === 'BEVESTIGD')).toEqual([]);
    // A quarter of another pool, where they are no member and have no link.
    const ander = insert('dienstrooster_pool', { naam: `AiosDt2-${tag}`, type: 'AIOS', ruleset_id: (db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(w.pool) as { ruleset_id: string }).ruleset_id, aangemaakt_op: now });
    const daar = insert('dienstrooster_schedule_period', {
      pool_id: ander,
      naam: `AiosDt2-${tag}`,
      start_datum: Q2.start_datum,
      eind_datum: Q2.eind_datum,
      deadline: '2097-02-05T17:00',
      status: 'OPEN',
      auto_herinneren: 0,
      aangemaakt_op: now,
    });
    expect((await geef(w.x, daar)).status).toBe(404);
    expect(rijen(w.x, daar)).toEqual([]);
  });
});

describe('around ISO week 53', () => {
  it('odd weeks: week 53 and week 1 both, two Mondays in a row; even weeks: the week between', async () => {
    // 2032 Q4 runs to Tuesday 4 January 2033: Monday 27 December is week 53, Monday 3 January week 1.
    const q = aiosQuarter(2032, 4);
    const kwartaal = insert('dienstrooster_schedule_period', {
      pool_id: w.pool,
      naam: `AiosDt53-${tag}`,
      start_datum: q.start_datum,
      eind_datum: q.eind_datum,
      deadline: '2032-08-02T17:00',
      status: 'OPEN',
      auto_herinneren: 0,
      aangemaakt_op: now,
    });
    db.transaction(() => persistAiosSlots(kwartaal, aiosShiftTypes(w.pool)!, q.start_datum, q.eind_datum))();
    for (const p of [w.x, w.y]) {
      insert('dienstrooster_pool_membership', { person_id: p, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2032-01-01', geldig_tot: '2033-12-31' });
    }
    const uitloop = (persoon: string) =>
      markeringen(persoon, kwartaal, 'PARTTIME').filter((d) => d.endsWith(' UD') && d >= '2032-12-20').map((d) => d.slice(0, 10));
    const oneven = (await maakPatroon(w.x, { weekdag: 'MA', frequentie: 'ONEVEN_WEKEN', geldig_vanaf: '2032-01-01', geldig_tot: '2033-12-31' })).status;
    const even = (await maakPatroon(w.y, { weekdag: 'MA', frequentie: 'EVEN_WEKEN', geldig_vanaf: '2032-01-01', geldig_tot: '2033-12-31' })).status;
    expect([oneven, even]).toEqual([201, 201]);
    // As the achterwacht's (lib/parttimeSync.ts): the ISO week number decides.
    expect(uitloop(w.x)).toEqual(['2032-12-27', '2033-01-03']);
    expect(uitloop(w.y)).toEqual(['2032-12-20']);
  });
});
