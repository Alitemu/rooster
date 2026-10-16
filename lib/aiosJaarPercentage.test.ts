import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db/client';
import { getHolidaysInRange } from '@/lib/holidays';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter, type AiosQuarter } from '@/lib/aiosQuarter';
import { aiosWerkdagen } from '@/lib/aiosFte';
import { aiosJaarPercentages } from '@/lib/aiosJaarPercentage';
import { laadAiosRooster, type AiosRooster } from '@/lib/aiosRooster';
import { aiosPublicatieControle } from '@/lib/aiosPublicatie';
import { aiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { deleteRowsAfter, insert, now, rowidSnapshot, tag } from '../tests/fixtures/dienstWorlds';

/**
 * The dienstpercentage over the last four quarters (lib/aiosJaarPercentage.ts,
 * G1): this quarter and the three before it together, points over werkdagen
 * x fte. A quarter before it in the app counts when published and the AIOS
 * was in it; one from before the pool's first quarter in the app comes from
 * the history read in, three of its months at a time while they last; the
 * rest is left out. Above 25% over them a warning at publishing, as for the
 * quarter.
 *
 * 2098: Q3 is this quarter, Q2 the pool's first in the app, Q1 and 2097 Q4
 * before the app.
 */

let snapshot: Map<string, number>;
const w = {} as { pool: string; dit: string; vorig: string; x: string; z: string };
const Q = {} as Record<'dit' | 'vorig' | 'twee' | 'drie', AiosQuarter>;
const HISTORIE = { nachten: 9, avonden: 10, avonden_weekend: 3, dagdiensten: 6, uitloopdiensten: 10 }; // 26 points

const werkdagen = (q: AiosQuarter) =>
  aiosWerkdagen({ beschikbaar: [{ van: q.start_datum, tot: q.eind_datum }], onderbreking: null }, q.start_datum, q.eind_datum, new Set(getHolidaysInRange(q.start_datum, q.eind_datum).map((h) => h.date)));
const zetStatus = (id: string, status: string) => db.prepare('UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?').run(status, id);
const dit = (person_id: string) => ({ person_id, punten: 10, werkdagen: 60, fte: 1 });
const jaar = (...ids: string[]) => aiosJaarPercentages(aiosUitnodigPeriode(w.dit)!, ids.map(dit));

beforeAll(() => {
  snapshot = rowidSnapshot();
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosJp-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosJp-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  Q.dit = aiosQuarter(2098, 3);
  Q.vorig = aiosQuarter(2098, 2);
  Q.twee = aiosQuarter(2098, 1);
  Q.drie = aiosQuarter(2097, 4);
  const periode = (q: AiosQuarter, status: string) => {
    const id = insert('dienstrooster_schedule_period', {
      pool_id: w.pool,
      naam: `AiosJp-${q.kwartaal}-${tag}`,
      start_datum: q.start_datum,
      eind_datum: q.eind_datum,
      deadline: '2097-01-01T17:00',
      status,
      auto_herinneren: 0,
      aangemaakt_op: now,
    });
    db.transaction(() => persistAiosSlots(id, aiosShiftTypes(w.pool)!, q.start_datum, q.eind_datum))();
    return id;
  };
  w.vorig = periode(Q.vorig, 'GEPUBLICEERD');
  w.dit = periode(Q.dit, 'GESLOTEN');
  const deelnemer = (n: string, vanaf: string) => {
    const id = insert('dienstrooster_person', { codenaam: `aiosjp-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: vanaf, geldig_tot: '2099-12-31' });
    return id;
  };
  // x since long ago, in last quarter too; z only from this quarter on.
  w.x = deelnemer('x', '2090-01-01');
  w.z = deelnemer('z', Q.dit.start_datum);
  // x had three nights last quarter.
  const nachten = db
    .prepare(
      `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND st.code = 'ND' ORDER BY sl.datum LIMIT 3`
    )
    .all(w.vorig) as Array<{ id: string }>;
  for (const n of nachten) insert('dienstrooster_assignment', { schedule_version_id: w.vorig, person_id: w.x, slot_id: n.id, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  // The history read in: six months for x at 1,0 fte, four for z at 0,8.
  for (const [person_id, fte, maanden] of [
    [w.x, 1, 6],
    [w.z, 0.8, 4],
  ] as const) {
    insert('dienstrooster_aios_beginstand', { pool_id: w.pool, person_id, ...HISTORIE, feestdagdiensten: 0, fte, maanden, ingelezen_op: now });
  }
});

afterAll(() => {
  deleteRowsAfter(snapshot);
});

describe('the dienstpercentage over four quarters', () => {
  it('counts a published quarter in the app and the history before the app, three months a quarter', () => {
    const x = jaar(w.x).get(w.x)!;
    expect(x.kwartalen).toBe(4);
    // Last quarter's three nights and its werkdagen; Q1 and 2097 Q4 from the history, three months each of its six.
    const verwacht = (10 + 3 + 26) / (60 + werkdagen(Q.vorig) + werkdagen(Q.twee) + werkdagen(Q.drie));
    expect(x.percentage).toBeCloseTo(verwacht, 10);
  });

  it('leaves out a quarter in the app the AIOS was not in, and uses the history while its months last', () => {
    const z = jaar(w.z).get(w.z)!;
    // Not in Q2 (the app's), Q1 from three of the four months, 2097 Q4 from the one left.
    expect(z.kwartalen).toBe(3);
    const verwacht = (10 + (26 * 3) / 4 + 26 / 4) / (60 + werkdagen(Q.twee) * 0.8 + (werkdagen(Q.drie) * 0.8) / 3);
    expect(z.percentage).toBeCloseTo(verwacht, 10);
  });

  it('counts a quarter in the app only once it is published, and never from the prullenbak', () => {
    zetStatus(w.vorig, 'GEGENEREERD');
    try {
      expect(jaar(w.x).get(w.x)!.kwartalen).toBe(3);
    } finally {
      zetStatus(w.vorig, 'GEPUBLICEERD');
    }
    db.prepare(`UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?`).run(now, w.vorig);
    try {
      // In the prullenbak the pool's first quarter is this one: Q2 is before the app now, but the history has six months only.
      expect(jaar(w.x).get(w.x)!.kwartalen).toBe(3);
    } finally {
      db.prepare(`UPDATE dienstrooster_schedule_period SET verwijderd_op = NULL WHERE id = ?`).run(w.vorig);
    }
  });

  it('is in the roster per AIOS', () => {
    const x = laadAiosRooster(aiosUitnodigPeriode(w.dit)!).per_aios.find((a) => a.person_id === w.x)!;
    expect(x.jaar_kwartalen).toBe(4);
    expect(x.jaar_percentage).toBeCloseTo((0 + 3 + 26) / (x.werkdagen * x.fte + werkdagen(Q.vorig) + werkdagen(Q.twee) + werkdagen(Q.drie)), 10);
  });

  it('warns at publishing above 25% over the quarters, not with this quarter alone', () => {
    const rooster = (a: { jaar_percentage: number; jaar_kwartalen: number }): AiosRooster =>
      ({ dagen: [], leeg: 0, overtredingen: [], per_aios: [{ codenaam: 'aios07', dienstpercentage: 0.2, ...a }] }) as unknown as AiosRooster;
    expect(aiosPublicatieControle(rooster({ jaar_percentage: 0.27, jaar_kwartalen: 4 })).waarschuwingen).toEqual([
      'aios07: dienstpercentage over vier kwartalen samen 27%, boven 25%.',
    ]);
    expect(aiosPublicatieControle(rooster({ jaar_percentage: 0.25, jaar_kwartalen: 4 })).waarschuwingen).toEqual([]);
    expect(aiosPublicatieControle(rooster({ jaar_percentage: 0.3, jaar_kwartalen: 1 })).waarschuwingen).toEqual([]);
  });
});
