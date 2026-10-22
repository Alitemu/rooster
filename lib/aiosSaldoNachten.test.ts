import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db/client';
import { aiosSaldi } from '@/lib/aiosSaldo';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, tag, type World } from '../tests/fixtures/dienstWorlds';

/**
 * The nights saldo from the quarter before (lib/aiosSaldo.ts, 0.107.0): the
 * fair number of nights the solver gave (aios_doel.doel_nachten, the years
 * before in it) minus the nights the AIOS did as the roster is now. A
 * quarter made before has no night target (NULL): its nights saldo is none,
 * or all its nights would read as too many.
 */

let snapshot: Map<string, number>;
let w: World;
let nachtType = '';
const nieuw = () => ({ id: 'volgend', pool_id: w.pool, start_datum: '2098-04-01' });

function nacht(datum: string, wie: string) {
  const slot = insert('dienstrooster_shift_slot', { period_id: w.period, shift_type_id: nachtType, datum, iso_jaar: 2098, iso_week: 11 });
  insert('dienstrooster_assignment', { schedule_version_id: w.period, person_id: wie, slot_id: slot, bron: 'SOLVER', aangemaakt_op: now });
}

beforeAll(() => {
  snapshot = rowidSnapshot();
  w = buildWorld('AIOS');
  nachtType = insert('dienstrooster_shift_type', { pool_id: w.pool, naam: 'Nachtdienst', teller: 'AVOND', code: 'ND', soort: 'NACHT', punten: 1 });
  // Two nights of x, none of y, in the published quarter before.
  nacht('2098-03-04', w.x);
  nacht('2098-03-05', w.x);
});
afterAll(() => deleteRowsAfter(snapshot));

describe('aiosSaldi, the nights', () => {
  it('is the target of the quarter before minus the nights done', () => {
    insert('dienstrooster_aios_doel', { period_id: w.period, person_id: w.x, doel_punten: 3, doel_feestdagen: 0, doel_nachten: 3.5 });
    insert('dienstrooster_aios_doel', { period_id: w.period, person_id: w.y, doel_punten: 3, doel_feestdagen: 0, doel_nachten: 3.5 });
    const s = aiosSaldi(nieuw(), [w.x, w.y]);
    // x did 2 of 3,5: 1,5 more now (a tenth, as everywhere); y did none: all 3,5.
    expect(s.get(w.x)).toMatchObject({ saldo_nachten: 1.5, bron: 'VORIG_KWARTAAL' });
    expect(s.get(w.y)).toMatchObject({ saldo_nachten: 3.5, bron: 'VORIG_KWARTAAL' });
  });

  it('counts a night that was changed by hand since: the roster as it is now', () => {
    db.prepare('UPDATE dienstrooster_assignment SET person_id = ? WHERE schedule_version_id = ? AND person_id = ? AND slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE datum = ?)').run(w.y, w.period, w.x, '2098-03-05');
    const s = aiosSaldi(nieuw(), [w.x, w.y]);
    expect(s.get(w.x)!.saldo_nachten).toBe(2.5);
    expect(s.get(w.y)!.saldo_nachten).toBe(2.5);
  });

  it('is none for a quarter made before the nights had a target (NULL), the points saldo still read', () => {
    db.prepare('UPDATE dienstrooster_aios_doel SET doel_nachten = NULL WHERE period_id = ?').run(w.period);
    const s = aiosSaldi(nieuw(), [w.x, w.y]);
    expect(s.get(w.x)).toMatchObject({ saldo_nachten: 0, bron: 'VORIG_KWARTAAL' });
    expect(s.get(w.x)!.saldo_punten).toBeGreaterThan(0);
  });

  it('is none for someone with no quarter before and no history', () => {
    const niemand = insert('dienstrooster_person', { codenaam: `geenhistorie-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    expect(aiosSaldi(nieuw(), [niemand]).get(niemand)).toMatchObject({ saldo_nachten: 0, bron: 'GEEN' });
  });
});
