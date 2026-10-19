import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { syncAiosPersoon } from '@/lib/aiosSync';
import {
  blokkadeTellers,
  loadAiosPeriode,
  loadAiosVoorkeurDagen,
  loadAiosWens,
  saveAiosWens,
  setAiosVoorkeur,
} from './aiosPreferences';
import { GET } from '@/app/api/aios/deelnemer/[id]/periode/[periodId]/route';
import { PATCH } from '@/app/api/aios/deelnemer/[id]/periode/[periodId]/slot/[slotId]/route';
import { staff, staffCookie } from '@/tests/fixtures/dienstWorlds';

/**
 * The rules (docs/aios-rooster.md, "Verzoeken van de AIOS"):
 * - a mark on an evening or night is the mark of its whole block;
 * - "geblokkeerd" is not possible on a feestdag, nor on a block with one;
 * - leave blocks its days and is "liever niet" on a feestdag; a part-time
 *   day blocks that day's UD and makes its evening liever niet, not its
 *   night; a mark by hand may not say less than the leave or the UD's
 *   block, and the evening's liever niet is the AIOS's to change;
 * - the 50% counters count only what was blocked by hand, a block once.
 *
 * 2034 Q2 runs from Wednesday 5 April to Tuesday 4 July 2034: Easter
 * Sunday and Monday (9 and 10 April) in the block Sunday to Tuesday,
 * Koningsdag on Thursday 27 April.
 */

const Q = aiosQuarter(2034, 2);
const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;

function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

function insert(table: string, row: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const cols = ['id', ...Object.keys(row)];
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
    id,
    ...Object.values(row).map((v) => v as never)
  );
  return id;
}

/** The person's mark on every dienst of a day, by code. */
function marks(personId: string, datum: string): Record<string, string | null> {
  const dag = loadAiosVoorkeurDagen(personId, ids.period).find((d) => d.datum === datum)!;
  return Object.fromEntries(dag.diensten.map((d) => [d.code, d.level ? `${d.level}/${d.bron}` : null]));
}

function slot(datum: string, code: string): string {
  return (
    db
      .prepare(
        `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
         WHERE sl.period_id = ? AND sl.datum = ? AND st.code = ?`
      )
      .get(ids.period, datum, code) as { id: string }
  ).id;
}

function person(name: string): string {
  const id = insert('dienstrooster_person', { codenaam: `aios-${name}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: new Date().toISOString() });
  insert('dienstrooster_pool_membership', { person_id: id, pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2030-01-01', geldig_tot: '2099-12-31' });
  return id;
}

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'AiosPref', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: `AiosPref-${crypto.randomUUID().slice(0, 6)}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, ids.pool);
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: 'AIOS 2034 Q2',
    start_datum: Q.start_datum,
    eind_datum: Q.eind_datum,
    deadline: '2034-02-01T17:00',
    status: 'OPEN',
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(ids.period, aiosShiftTypes(ids.pool)!, Q.start_datum, Q.eind_datum))();
  ids.a = person('a');
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('marking an AIOS dienst', () => {
  it('marks the whole block when one evening is marked, and a single dienst alone', () => {
    // Monday 17 April: its evening is in the block Sunday 16 to Tuesday 18.
    expect(setAiosVoorkeur(ids.a, ids.period, slot('2034-04-17', 'AD'), 'ABSOLUUT')).toEqual({ ok: true });
    expect(marks(ids.a, '2034-04-16')).toMatchObject({ ADW: 'ABSOLUUT/MANUAL', DD: null, ND: null });
    expect(marks(ids.a, '2034-04-17')).toMatchObject({ AD: 'ABSOLUUT/MANUAL', UD: null, ND: null });
    expect(marks(ids.a, '2034-04-18')).toMatchObject({ AD: 'ABSOLUUT/MANUAL' });
    expect(marks(ids.a, '2034-04-19')).toMatchObject({ AD: null }); // the next block

    expect(setAiosVoorkeur(ids.a, ids.period, slot('2034-04-19', 'UD'), 'VOORKEUR')).toEqual({ ok: true });
    expect(marks(ids.a, '2034-04-19')).toMatchObject({ UD: 'VOORKEUR/MANUAL', AD: null });
    expect(marks(ids.a, '2034-04-20')).toMatchObject({ UD: null });

    // Cleared again: the whole block.
    expect(setAiosVoorkeur(ids.a, ids.period, slot('2034-04-16', 'ADW'), null)).toEqual({ ok: true });
    expect(marks(ids.a, '2034-04-17')).toMatchObject({ AD: null });
  });

  it('refuses "geblokkeerd" on a feestdag and on a block with one, not "liever niet"', () => {
    const b = person('b');
    // Koningsdag, Thursday 27 April: its DD is a single dienst.
    expect(setAiosVoorkeur(b, ids.period, slot('2034-04-27', 'DD'), 'ABSOLUUT')).toMatchObject({ ok: false, code: 'FEESTDAG' });
    expect(setAiosVoorkeur(b, ids.period, slot('2034-04-27', 'DD'), 'LIEVER_NIET')).toEqual({ ok: true });
    // The night block Sunday 9 to Tuesday 11 April holds Easter.
    expect(setAiosVoorkeur(b, ids.period, slot('2034-04-11', 'ND'), 'ABSOLUUT')).toMatchObject({
      ok: false,
      code: 'FEESTDAG',
      message: expect.stringMatching(/In dit blok valt een feestdag/),
    });
    expect(marks(b, '2034-04-11')).toMatchObject({ ND: null });
  });

  it('blocks leave, as "liever niet" on a feestdag, and keeps a mark from saying less', () => {
    const c = person('c');
    // Leave from Saturday 8 to Monday 10 April: Easter Sunday and Monday are feestdagen.
    insert('dienstrooster_absence', { person_id: c, van_datum: '2034-04-08', tot_datum: '2034-04-10', soort: 'VAKANTIE', aangemaakt_door: c, aangemaakt_op: new Date().toISOString() });
    syncAiosPersoon(c);
    expect(marks(c, '2034-04-08')).toEqual({ DD: 'ABSOLUUT/ABSENCE', ADW: 'ABSOLUUT/ABSENCE', ND: 'ABSOLUUT/ABSENCE' });
    expect(marks(c, '2034-04-09')).toEqual({ DD: 'LIEVER_NIET/ABSENCE', ADW: 'LIEVER_NIET/ABSENCE', ND: 'LIEVER_NIET/ABSENCE' });
    expect(marks(c, '2034-04-11')).toEqual({ UD: null, AD: null, ND: null });

    // A voorkeur for that block says less than the leave: refused, nothing written.
    expect(setAiosVoorkeur(c, ids.period, slot('2034-04-11', 'AD'), 'VOORKEUR')).toMatchObject({ ok: false, code: 'IN_AFWEZIGHEID' });
    expect(marks(c, '2034-04-11')).toMatchObject({ AD: null });
    // "Liever niet" is what the leave says there: the rest of the block gets it, the leave keeps its own.
    expect(setAiosVoorkeur(c, ids.period, slot('2034-04-11', 'AD'), 'LIEVER_NIET')).toEqual({ ok: true });
    expect(marks(c, '2034-04-11')).toMatchObject({ AD: 'LIEVER_NIET/MANUAL' });
    expect(marks(c, '2034-04-10')).toMatchObject({ ADW: 'LIEVER_NIET/ABSENCE' });
  });

  it("blocks a part-time day's UD and makes its evening liever niet, which the AIOS may change, and leaves its night", () => {
    const d = person('d');
    insert('dienstrooster_parttime_pattern', { person_id: d, weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2030-01-01', geldig_tot: '2099-12-31', aangemaakt_door: d, aangemaakt_op: new Date().toISOString() });
    syncAiosPersoon(d);
    // The planner's choice in October 2026: the evening may be planned, rather not; the night as any other.
    expect(marks(d, '2034-04-17')).toEqual({ UD: 'ABSOLUUT/PARTTIME', AD: 'LIEVER_NIET/PARTTIME', ND: null });
    // The uitloopdienst stays blocked.
    const nee = setAiosVoorkeur(d, ids.period, slot('2034-04-17', 'UD'), 'LIEVER_NIET');
    expect(nee).toMatchObject({ ok: false, code: 'IN_DEELTIJD' });
    expect((nee as { message: string }).message).toContain('geen uitloopdienst');
    // A voorkeur for the evening block over that Monday is theirs, the Monday too; clearing it brings the liever niet back.
    expect(setAiosVoorkeur(d, ids.period, slot('2034-04-16', 'ADW'), 'VOORKEUR')).toEqual({ ok: true });
    expect(marks(d, '2034-04-17')).toMatchObject({ AD: 'VOORKEUR/MANUAL' });
    syncAiosPersoon(d);
    expect(marks(d, '2034-04-17')).toMatchObject({ AD: 'VOORKEUR/MANUAL' });
    expect(setAiosVoorkeur(d, ids.period, slot('2034-04-16', 'ADW'), null)).toEqual({ ok: true });
    expect(marks(d, '2034-04-17')).toMatchObject({ AD: 'LIEVER_NIET/PARTTIME' });
    // Blocking it is theirs too, and counts for the 50% rule.
    const voor = blokkadeTellers(loadAiosVoorkeurDagen(d, ids.period)).find((t) => t.groep === 'AVONDBLOKKEN')!.geblokkeerd;
    expect(setAiosVoorkeur(d, ids.period, slot('2034-04-16', 'ADW'), 'ABSOLUUT')).toEqual({ ok: true });
    expect(marks(d, '2034-04-17')).toMatchObject({ AD: 'ABSOLUUT/MANUAL' });
    expect(blokkadeTellers(loadAiosVoorkeurDagen(d, ids.period)).find((t) => t.groep === 'AVONDBLOKKEN')!.geblokkeerd).toBe(voor + 1);
    syncAiosPersoon(d);
    expect(marks(d, '2034-04-17')).toMatchObject({ AD: 'ABSOLUUT/MANUAL' });
    // The night is the AIOS's alone: cleared, nothing comes back.
    expect(setAiosVoorkeur(d, ids.period, slot('2034-04-17', 'ND'), 'VOORKEUR')).toEqual({ ok: true });
    expect(marks(d, '2034-04-18')).toMatchObject({ ND: 'VOORKEUR/MANUAL' });
    expect(setAiosVoorkeur(d, ids.period, slot('2034-04-17', 'ND'), null)).toEqual({ ok: true });
    expect(marks(d, '2034-04-17')).toMatchObject({ ND: null });
  });

  it('takes the liever niet of 0.82.0 off a part-time night', () => {
    const g = person('g');
    const patroon = insert('dienstrooster_parttime_pattern', { person_id: g, weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2030-01-01', geldig_tot: '2099-12-31', aangemaakt_door: g, aangemaakt_op: new Date().toISOString() });
    syncAiosPersoon(g);
    // 0.82.0 marked the night of a part-time day too.
    insert('dienstrooster_availability', { person_id: g, slot_id: slot('2034-04-17', 'ND'), blocking_level: 'LIEVER_NIET', source: 'PARTTIME', bron_pattern_id: patroon, aangemaakt_op: new Date().toISOString() });
    expect(marks(g, '2034-04-17')).toMatchObject({ ND: 'LIEVER_NIET/PARTTIME' });
    syncAiosPersoon(g);
    expect(marks(g, '2034-04-17')).toEqual({ UD: 'ABSOLUUT/PARTTIME', AD: 'LIEVER_NIET/PARTTIME', ND: null });
  });

  it("puts a part-time evening blocked before 0.82.0 at liever niet, and leaves the AIOS's own marks", () => {
    const f = person('f');
    // From before the part-time day: a voorkeur for the night block over that Monday and for its uitloopdienst.
    expect(setAiosVoorkeur(f, ids.period, slot('2034-04-16', 'ND'), 'VOORKEUR')).toEqual({ ok: true });
    expect(setAiosVoorkeur(f, ids.period, slot('2034-04-17', 'UD'), 'VOORKEUR')).toEqual({ ok: true });
    insert('dienstrooster_parttime_pattern', { person_id: f, weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2030-01-01', geldig_tot: '2099-12-31', aangemaakt_door: f, aangemaakt_op: new Date().toISOString() });
    syncAiosPersoon(f);
    db.prepare(`UPDATE dienstrooster_availability SET blocking_level = 'ABSOLUUT' WHERE person_id = ? AND source = 'PARTTIME' AND slot_id = ?`).run(f, slot('2034-04-17', 'AD'));
    syncAiosPersoon(f);
    // The uitloopdienst's block takes the voorkeur over; the night keeps it; the old blocked evening is liever niet now.
    expect(marks(f, '2034-04-17')).toEqual({ UD: 'ABSOLUUT/PARTTIME', AD: 'LIEVER_NIET/PARTTIME', ND: 'VOORKEUR/MANUAL' });
  });
});

describe('the 50% counters', () => {
  /** The blocks of this kind in the quarter without a feestdag in them: what can be blocked. */
  const blokTotaal = (soort: string, vormen: string[]) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM dienstrooster_shift_block b
           WHERE b.period_id = ? AND b.soort = ? AND b.vorm IN (${vormen.map(() => '?').join(',')})
             AND NOT EXISTS (SELECT 1 FROM dienstrooster_shift_slot s WHERE s.shift_block_id = b.id AND s.is_feestdag = 1)`
        )
        .get(ids.period, soort, ...vormen) as { n: number }
    ).n;
  it('count a block once, only what was blocked by hand, and warn above half', () => {
    const e = person('e');
    insert('dienstrooster_absence', { person_id: e, van_datum: '2034-05-01', tot_datum: '2034-05-31', soort: 'VAKANTIE', aangemaakt_door: e, aangemaakt_op: new Date().toISOString() });
    syncAiosPersoon(e);
    const nul = blokkadeTellers(loadAiosVoorkeurDagen(e, ids.period));
    // A month of leave counts for nothing.
    expect(nul.every((t) => t.geblokkeerd === 0)).toBe(true);

    setAiosVoorkeur(e, ids.period, slot('2034-04-17', 'AD'), 'ABSOLUUT'); // one evening block
    setAiosVoorkeur(e, ids.period, slot('2034-04-15', 'ND'), 'ABSOLUUT'); // a Saturday night
    setAiosVoorkeur(e, ids.period, slot('2034-04-15', 'DD'), 'ABSOLUUT'); // a Saturday day shift
    setAiosVoorkeur(e, ids.period, slot('2034-04-18', 'UD'), 'ABSOLUUT'); // an uitloopdienst
    const t = Object.fromEntries(blokkadeTellers(loadAiosVoorkeurDagen(e, ids.period)).map((x) => [x.groep, x]));
    expect(t.AVONDBLOKKEN).toMatchObject({ geblokkeerd: 1, totaal: blokTotaal('AVOND', ['ZO_DI', 'WO_VR']), boven_helft: false });
    // Half per dienst: the Saturday night and evening count apart.
    expect(t.ZATERDAG_NACHT).toMatchObject({ geblokkeerd: 1, totaal: blokTotaal('NACHT', ['ZA']) });
    expect(t.ZATERDAG_AVOND).toMatchObject({ geblokkeerd: 0, totaal: blokTotaal('AVOND', ['ZA']) });
    // Weekend dagdiensten only: a feestdag can't be blocked, so it is not in the total.
    expect(t.DAGDIENSTEN.totaal).toBe(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM dienstrooster_shift_slot s JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
             WHERE s.period_id = ? AND st.code = 'DD' AND s.is_feestdag = 0`
          )
          .get(ids.period) as { n: number }
      ).n
    );
    expect(t.DAGDIENSTEN.geblokkeerd).toBe(1);
    // The uitloopdiensten have a counter of their own, over all of the quarter's.
    const ud = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM dienstrooster_shift_slot s JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
           WHERE s.period_id = ? AND st.code = 'UD'`
        )
        .get(ids.period) as { n: number }
    ).n;
    expect(t.UITLOOPDIENSTEN).toMatchObject({ geblokkeerd: 1, totaal: ud, boven_helft: false });
    expect(t.NACHTBLOKKEN.geblokkeerd).toBe(0);

    // Every evening block but the ones with a feestdag: more than half.
    const dagen = loadAiosVoorkeurDagen(e, ids.period);
    const blokken = new Map<string, string>();
    for (const dag of dagen) for (const d of dag.diensten) if (d.blok && d.blok.soort === 'AVOND' && d.blok.vorm !== 'ZA') blokken.set(d.blok.id, d.slot_id);
    for (const slotId of blokken.values()) setAiosVoorkeur(e, ids.period, slotId, 'ABSOLUUT');
    const na = blokkadeTellers(loadAiosVoorkeurDagen(e, ids.period)).find((x) => x.groep === 'AVONDBLOKKEN')!;
    expect(na.boven_helft).toBe(true);
  });

  it('give the Saturday night a half of its own: every Saturday night blocked warns there, not for the evening', () => {
    const f = person('f');
    const zaterdagen = loadAiosVoorkeurDagen(f, ids.period).flatMap((dag) =>
      dag.diensten.filter((d) => d.blok?.vorm === 'ZA' && d.blok.soort === 'NACHT' && dag.dag_soort !== 'FEESTDAG')
    );
    for (const d of zaterdagen) expect(setAiosVoorkeur(f, ids.period, d.slot_id, 'ABSOLUUT')).toEqual({ ok: true });
    const t = Object.fromEntries(blokkadeTellers(loadAiosVoorkeurDagen(f, ids.period)).map((x) => [x.groep, x]));
    const totaal = blokTotaal('NACHT', ['ZA']);
    expect(t.ZATERDAG_NACHT).toMatchObject({ geblokkeerd: zaterdagen.length, totaal, boven_helft: true });
    expect(t.ZATERDAG_NACHT.erboven).toBe(zaterdagen.length - Math.floor(totaal / 2));
    expect(t.ZATERDAG_AVOND).toMatchObject({ geblokkeerd: 0, boven_helft: false, erboven: 0 });
  });
});

describe('what an AIOS asks besides', () => {
  it('keeps the dates within the quarter, both or neither, in order, and the request short', () => {
    const f = person('f');
    const period = loadAiosPeriode(ids.period)!;
    expect(saveAiosWens(f, period, { inwerken_van: '2034-04-05', inwerken_tot: null })).toMatchObject({ ok: false, code: 'INVALID_DATE' });
    expect(saveAiosWens(f, period, { inwerken_van: '2034-05-01', inwerken_tot: '2034-04-01' })).toMatchObject({ ok: false });
    expect(saveAiosWens(f, period, { onderbreking_van: '2034-03-01', onderbreking_tot: '2034-04-10' })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/binnen het kwartaal/),
    });
    expect(saveAiosWens(f, period, { vier_avonden: 'ja' })).toMatchObject({ ok: false });

    expect(
      saveAiosWens(f, period, {
        vier_avonden: true,
        twee_dagdiensten: true,
        inwerken_van: '2034-04-05',
        inwerken_tot: '2034-05-04',
      })
    ).toEqual({ ok: true });
    expect(loadAiosWens(f, ids.period)).toEqual({
      vier_avonden: true,
      vier_nachten: false,
      twee_dagdiensten: true,
      inwerken_van: '2034-04-05',
      inwerken_tot: '2034-05-04',
      onderbreking_van: null,
      onderbreking_tot: null,
    });
    // The free text for general requests is gone (0.97.0): an old client that still sends it changes nothing.
    expect(saveAiosWens(f, period, { vier_avonden: true, opmerking: 'Liever geen nachten in juni' })).toEqual({ ok: true });
    expect(loadAiosWens(f, ids.period)).not.toHaveProperty('opmerking');
  });
});

describe('the routes', () => {
  const cookie = (personId: string) =>
    `${SESSION_COOKIE_NAME}=${createSessionToken({ kind: 'person', personId, sessionVersion: getSessionVersion(personId)! } as never, STAFF_SESSION_MAX_AGE_SECONDS)}`;

  it("give the AIOS their own screen and take their marks, until the deadline", async () => {
    const g = person('g');
    // A participant's session holds while they have a link that is not withdrawn.
    insert('dienstrooster_person_access_link', { person_id: g, token_hash: crypto.randomBytes(32).toString('hex'), aangemaakt_op: new Date().toISOString() });
    const res = await GET(new NextRequest(`http://localhost/api/aios/deelnemer/${g}/periode/${ids.period}`, { headers: { Cookie: cookie(g) } }), {
      params: Promise.resolve({ id: g, periodId: ids.period }),
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.dagen).toHaveLength(91);
    expect(data.tellers).toHaveLength(6);
    expect(data.invoer).toEqual({ open: true });

    const patch = (level: unknown) =>
      PATCH(
        new NextRequest(`http://localhost/api/aios/deelnemer/${g}/periode/${ids.period}/slot/x`, {
          method: 'PATCH',
          headers: { Cookie: cookie(g), 'Content-Type': 'application/json' },
          body: JSON.stringify({ level }),
        }),
        { params: Promise.resolve({ id: g, periodId: ids.period, slotId: slot('2034-04-19', 'ND') }) }
      );
    expect((await patch('ZO')).status).toBe(400);
    expect((await patch('LIEVER_NIET')).status).toBe(200);
    expect(marks(g, '2034-04-21')).toMatchObject({ ND: 'LIEVER_NIET/MANUAL' });

    // An achterwacht period is no AIOS period, for its own participant too
    // (who is refused on the AIOS's routes anyway, lib/aiosToegang.ts geenAiosDenial).
    const ruleset = insert('dienstrooster_ruleset', { naam: 'Staf', config_json: '{}', aangemaakt_op: new Date().toISOString() });
    const stafPool = insert('dienstrooster_pool', { naam: `Staf-${crypto.randomUUID().slice(0, 6)}`, type: 'ACHTERWACHT', ruleset_id: ruleset, aangemaakt_op: new Date().toISOString() });
    const stafPeriod = insert('dienstrooster_schedule_period', { pool_id: stafPool, naam: 'Staf', start_datum: '2034-04-03', eind_datum: '2034-06-25', deadline: '2034-02-01T17:00', status: 'OPEN', aangemaakt_op: new Date().toISOString() });
    const staf = insert('dienstrooster_person', { codenaam: `staf-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: new Date().toISOString() });
    insert('dienstrooster_pool_membership', { person_id: staf, pool_id: stafPool, deelnamefactor: 1, geldig_vanaf: '2030-01-01', geldig_tot: '2099-12-31' });
    insert('dienstrooster_person_access_link', { person_id: staf, token_hash: crypto.randomBytes(32).toString('hex'), aangemaakt_op: new Date().toISOString() });
    const stafRes = await GET(new NextRequest(`http://localhost/api/aios/deelnemer/${staf}/periode/${stafPeriod}`, { headers: { Cookie: cookie(staf) } }), {
      params: Promise.resolve({ id: staf, periodId: stafPeriod }),
    });
    expect(stafRes.status).toBe(404);
    // Nor for an AIOS, even through the beheerder, who sees every dienst: the AIOS's screen loads only an AIOS period.
    const viaBeheerder = await GET(
      new NextRequest(`http://localhost/api/aios/deelnemer/${g}/periode/${stafPeriod}`, { headers: { Cookie: staffCookie(staff('ADMIN', 'ACHTERWACHT')) } }),
      { params: Promise.resolve({ id: g, periodId: stafPeriod }) }
    );
    expect(viaBeheerder.status).toBe(404);

    db.prepare(`UPDATE dienstrooster_schedule_period SET deadline = '2020-01-01T17:00' WHERE id = ?`).run(ids.period);
    try {
      expect((await patch('VOORKEUR')).status).toBe(403);
      expect(marks(g, '2034-04-21')).toMatchObject({ ND: 'LIEVER_NIET/MANUAL' });
    } finally {
      db.prepare(`UPDATE dienstrooster_schedule_period SET deadline = '2034-02-01T17:00' WHERE id = ?`).run(ids.period);
    }
  });
});
