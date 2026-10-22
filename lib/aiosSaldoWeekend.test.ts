import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db/client';
import { aiosSaldi, aiosSaldoWoorden, beginstandSaldi, type Beginstand } from '@/lib/aiosSaldo';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, type World } from '../tests/fixtures/dienstWorlds';

/**
 * The saldo of the dagdiensten and of the avonddiensten in the weekend
 * (lib/aiosSaldo.ts, 0.108.0), as the nights' (aiosSaldoNachten.test.ts):
 * the target the solver gave minus what the AIOS did as the roster is now,
 * NULL (a quarter made before) counting as none, and from the history the
 * fair part of all of them.
 */

let snapshot: Map<string, number>;
let w: World;
let dagType = '';
let avondType = '';
const nieuw = () => ({ id: 'volgend', pool_id: w.pool, start_datum: '2098-04-01' });

function dienst(type: string, datum: string, wie: string) {
  const slot = insert('dienstrooster_shift_slot', { period_id: w.period, shift_type_id: type, datum, iso_jaar: 2098, iso_week: 10 });
  insert('dienstrooster_assignment', { schedule_version_id: w.period, person_id: wie, slot_id: slot, bron: 'SOLVER', aangemaakt_op: now });
}

beforeAll(() => {
  snapshot = rowidSnapshot();
  w = buildWorld('AIOS');
  dagType = insert('dienstrooster_shift_type', { pool_id: w.pool, naam: 'Dagdienst', teller: 'AVOND', code: 'DD', soort: 'DAG', punten: 1 });
  avondType = insert('dienstrooster_shift_type', { pool_id: w.pool, naam: 'Avonddienst weekend', teller: 'AVOND', code: 'ADW', soort: 'AVOND', punten: 1 });
  // x did two dagdiensten and one weekend evening, y a weekend evening, in the published quarter before.
  dienst(dagType, '2098-03-07', w.x);
  dienst(dagType, '2098-03-08', w.x);
  dienst(avondType, '2098-03-07', w.x);
  dienst(avondType, '2098-03-08', w.y);
  insert('dienstrooster_aios_doel', { period_id: w.period, person_id: w.x, doel_punten: 3, doel_feestdagen: 0, doel_nachten: 0, doel_dagen: 1.5, doel_weekendavonden: 1.5 });
  insert('dienstrooster_aios_doel', { period_id: w.period, person_id: w.y, doel_punten: 3, doel_feestdagen: 0, doel_nachten: 0, doel_dagen: 1.5, doel_weekendavonden: 1.5 });
});
afterAll(() => deleteRowsAfter(snapshot));

describe('aiosSaldi, the weekend', () => {
  it('is the target of the quarter before minus the dagdiensten and weekend evenings done, each on its own', () => {
    const s = aiosSaldi(nieuw(), [w.x, w.y]);
    // x did 2 dagdiensten of 1,5 (half too many) and 1 evening of 1,5 (half too few); y the reverse.
    expect(s.get(w.x)).toMatchObject({ saldo_dagen: -0.5, saldo_weekendavonden: 0.5, bron: 'VORIG_KWARTAAL' });
    expect(s.get(w.y)).toMatchObject({ saldo_dagen: 1.5, saldo_weekendavonden: 0.5 });
  });

  it('is none for a quarter made before the weekend had a target (NULL), the points saldo still read', () => {
    db.prepare('UPDATE dienstrooster_aios_doel SET doel_dagen = NULL, doel_weekendavonden = NULL WHERE period_id = ?').run(w.period);
    const s = aiosSaldi(nieuw(), [w.x, w.y]);
    expect(s.get(w.x)).toMatchObject({ saldo_dagen: 0, saldo_weekendavonden: 0, bron: 'VORIG_KWARTAAL' });
  });
});

describe('beginstandSaldi, the weekend', () => {
  const rij = (person_id: string, dagdiensten: number, avonden_weekend: number): Beginstand => ({
    person_id,
    nachten: 0,
    avonden: 0,
    avonden_weekend,
    dagdiensten,
    uitloopdiensten: 0,
    feestdagdiensten: 0,
    fte: 1,
    maanden: 12,
  });

  it('is the fair part of all of them minus what each did, the dagdiensten apart from the evenings', () => {
    const s = beginstandSaldi([rij('x', 8, 2), rij('y', 2, 8)]);
    expect(s.get('x')).toMatchObject({ saldo_dagen: -3, saldo_weekendavonden: 3 });
    expect(s.get('y')).toMatchObject({ saldo_dagen: 3, saldo_weekendavonden: -3 });
  });
});

describe('in words, the weekend', () => {
  const s = { saldo_punten: 0, saldo_nachten: 0, saldo_dagen: 0, saldo_weekendavonden: 0, feestdag_achterstand: 0 };

  it('a dagdienst or weekendavonddienst, extra or minder', () => {
    expect(aiosSaldoWoorden({ ...s, saldo_dagen: 1 })).toBe('1 dagdienst extra');
    expect(aiosSaldoWoorden({ ...s, saldo_dagen: -2 })).toBe('2 dagdiensten minder');
    expect(aiosSaldoWoorden({ ...s, saldo_weekendavonden: 1.5 })).toBe('1,5 weekendavonddiensten extra');
    expect(aiosSaldoWoorden({ ...s, saldo_weekendavonden: -1 })).toBe('1 weekendavonddienst minder');
    expect(aiosSaldoWoorden({ ...s, saldo_dagen: 0.02, saldo_weekendavonden: -0.02 })).toBe('niets in te halen');
    expect(aiosSaldoWoorden({ ...s, saldo_punten: 1, saldo_dagen: -1, saldo_weekendavonden: 2 })).toBe(
      '1 punt extra, 1 dagdienst minder en 2 weekendavonddiensten extra'
    );
  });
});
