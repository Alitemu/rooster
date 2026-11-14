import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { aiosSolverInvoer } from '@/lib/aiosSolverInvoer';
import { laadAiosRooster } from '@/lib/aiosRooster';
import { deleteRowsAfter, insert, now, rowidSnapshot, tag } from '../../../tests/fixtures/dienstWorlds';

/**
 * Rules 7, 8 and 9 over the boundary, forward (0.805.0): when the roster of
 * the next quarter exists, what an AIOS has in its first eight days is taken
 * along in the app's check, so a swap or a change by hand in the last days of
 * this quarter cannot break their rest or compensation days over there. The
 * solver is never sent it (it makes one quarter at a time).
 */

let snapshot: Map<string, number>;
const w = {} as { pool: string; a: string; b: string; c: string; z: string };

const periode = (id: string) => aiosUitnodigPeriode(id)!;
const slots = (period: string) =>
  db
    .prepare(
      `SELECT sl.id, sl.datum, st.code FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND st.code IS NOT NULL ORDER BY sl.datum, st.start_tijd`
    )
    .all(period) as Array<{ id: string; datum: string; code: string }>;
const geef = (periodId: string, slotId: string, persoon: string) =>
  insert('dienstrooster_assignment', { schedule_version_id: periodId, person_id: persoon, slot_id: slotId, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
const zetStatus = (id: string, s: string) => db.prepare('UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?').run(s, id);
const latere = (aios: string, periodId = w.a) => aiosSolverInvoer(periode(periodId), 60).aios.find((a) => a.id === aios)!.latere_diensten;

beforeAll(() => {
  snapshot = rowidSnapshot();
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosGrens-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosGrens-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  const maak = (naam: string, van: string, tot: string, status: string) => {
    const id = insert('dienstrooster_schedule_period', {
      pool_id: w.pool, naam: `AiosGrens-${naam}-${tag}`, start_datum: van, eind_datum: tot, deadline: '2094-05-01T17:00', status, auto_herinneren: 0, aangemaakt_op: now,
    });
    db.transaction(() => persistAiosSlots(id, aiosShiftTypes(w.pool)!, van, tot))();
    return id;
  };
  // Two quarters in a row, three weeks each, no feestdagen near.
  w.a = maak('A', '2094-07-07', '2094-07-27', 'GEGENEREERD');
  w.b = maak('B', '2094-07-28', '2094-08-17', 'GEGENEREERD');
  // A third one: the next quarter of A is B, not the one furthest on.
  w.c = maak('C', '2094-08-18', '2094-09-07', 'GEGENEREERD');
  w.z = insert('dienstrooster_person', { codenaam: `aiosgrens-z-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  insert('dienstrooster_pool_membership', { person_id: w.z, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
});
afterAll(() => deleteRowsAfter(snapshot));

describe('what the next quarter gives to the check', () => {
  it('is the AIOS\'s diensten in its first eight days, and no more', () => {
    const eerste = slots(w.b)[0];
    const laat = slots(w.b).filter((s) => s.datum >= '2094-08-10')[0];
    geef(w.b, eerste.id, w.z);
    geef(w.b, laat.id, w.z);
    const gekregen = latere(w.z)!;
    expect(gekregen.map((d) => d.id)).toEqual([eerste.id]);
    expect(gekregen[0]).toMatchObject({ datum: eerste.datum, code: eerste.code });
    expect(gekregen[0].start_tijd).toMatch(/^\d{2}:\d{2}$/);
  });

  it('is never sent to the solver (the generation)', () => {
    const invoer = aiosSolverInvoer(periode(w.a), 60, { vers: true });
    expect(invoer.aios.every((a) => a.latere_diensten === undefined)).toBe(true);
  });

  it('needs a roster in the quarter right after: a closed one, one in the prullenbak and none at all give nothing', () => {
    zetStatus(w.b, 'GESLOTEN');
    try {
      expect(latere(w.z)).toBeUndefined();
    } finally {
      zetStatus(w.b, 'GEGENEREERD');
    }
    db.prepare("UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?").run(now, w.b);
    try {
      // The quarter after the trashed one is no neighbour: nothing within eight days of it.
      expect(latere(w.z)).toEqual([]);
    } finally {
      db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = NULL WHERE id = ?').run(w.b);
    }
    expect(latere(w.z, w.c)).toBeUndefined();
  });
});

describe('the roster page of this quarter', () => {
  it('names what a dienst in the last days breaks over the boundary, and not without the next quarter\'s roster', () => {
    // A single night on the last day of A and a dienst of the same AIOS the morning after, in B: less than the rest asked.
    const laatsteNacht = slots(w.a).filter((s) => s.code === 'ND').at(-1)!;
    // z still holds the first dienst of B from the first test.
    expect(latere(w.z)).toHaveLength(1);
    geef(w.a, laatsteNacht.id, w.z);
    zetStatus(w.b, 'GESLOTEN');
    const zonder = laadAiosRooster(periode(w.a)).overtredingen.filter((o) => ['7_COMPENSATIEDAG', '9_RUST'].includes(o.regel));
    zetStatus(w.b, 'GEGENEREERD');
    const met = laadAiosRooster(periode(w.a)).overtredingen.filter((o) => ['7_COMPENSATIEDAG', '9_RUST'].includes(o.regel));
    expect(zonder).toEqual([]);
    // A night on the last day (a single one: compensation day after) and the uitloopdienst the day after, in B.
    expect(met.map((o) => o.regel).sort()).toEqual(['7_COMPENSATIEDAG', '9_RUST']);
    // Only the day of this quarter is named: the other dienst is the next quarter's.
    expect(met.every((o) => o.datums.length === 1 && o.datums[0] === laatsteNacht.datum)).toBe(true);
  });
});
