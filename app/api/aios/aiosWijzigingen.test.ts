import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { readFirstSheet } from '@/lib/xlsx';
import { excelSerialToDate } from '@/lib/isoDate';
import { GET as wijzigingen } from './periode/[id]/download-wijzigingen/route';
import { buildWorld, deleteRowsAfter, insert, now, personCookie, rowidSnapshot, staff, staffCookie, tag, type World } from '../../../tests/fixtures/dienstWorlds';

/**
 * The AIOS's wijzigingsgeschiedenis (lib/aiosWijzigingen.ts): every change
 * by hand and every swap of the quarter, with the reason and who did it, in
 * the order it happened; only the AIOS's planner (and the beheerder), and
 * nothing of another period.
 */

let snapshot: Map<string, number>;
let staf: World;
const w = {} as { pool: string; period: string; andere: string; planner: string; x: string; y: string };
const START = '2094-07-07';
const EIND = '2094-07-20';
const cn = (n: string) => `aioswj-${n}-${tag}`;

const slot = (periode: string, code: string, datum: string) =>
  (
    db
      .prepare(
        `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
         WHERE sl.period_id = ? AND st.code = ? AND sl.datum = ?`
      )
      .get(periode, code, datum) as { id: string }
  ).id;
const download = (periode: string, cookie: string) =>
  wijzigingen(new NextRequest(`http://localhost/api/aios/periode/${periode}/download-wijzigingen`, { headers: { cookie } }), {
    params: Promise.resolve({ id: periode }),
  });

beforeAll(() => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosWj-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosWj-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  const periode = (naam: string) => {
    const id = insert('dienstrooster_schedule_period', {
      pool_id: w.pool,
      naam,
      start_datum: START,
      eind_datum: EIND,
      deadline: '2094-05-01T17:00',
      status: 'GEPUBLICEERD',
      auto_herinneren: 0,
      aangemaakt_op: now,
    });
    db.transaction(() => persistAiosSlots(id, aiosShiftTypes(w.pool)!, START, EIND))();
    return id;
  };
  w.period = periode(`AiosWj-${tag}`);
  const deelnemer = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: cn(n), rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
  // The planner takes the Saturday dagdienst from y and gives it to x, with a reason; then x and y swap.
  const dd = slot(w.period, 'DD', '2094-07-10');
  const ud = slot(w.period, 'UD', '2094-07-12');
  const toewijzing = insert('dienstrooster_assignment', { schedule_version_id: w.period, person_id: w.x, slot_id: dd, bron: 'MANUAL', row_version: 1, aangemaakt_op: now });
  const eerste = insert('dienstrooster_assignment', { schedule_version_id: w.period, person_id: w.y, slot_id: ud, bron: 'MANUAL', row_version: 1, aangemaakt_op: now });
  const edit = (id: string, person: string, slotId: string, type: string, reden: string, door: string, op: string, oud?: string) =>
    insert('dienstrooster_assignment_edit', {
      toewijzing_id: id,
      periode_id: w.period,
      person_id: person,
      slot_id: slotId,
      edit_type: type,
      oorspronkelijke_person_id: oud ?? null,
      reden,
      bewerkt_door_person_id: door,
      aangemaakt_op: op,
      row_version: 1,
    });
  edit(toewijzing, w.y, dd, 'HANDMATIG_VERWIJDEREN', 'y is ziek', w.planner, '2094-06-01T10:00:00.000Z');
  edit(toewijzing, w.x, dd, 'HANDMATIG_TOEWIJZEN', 'y is ziek', w.planner, '2094-06-01T10:00:01.000Z');
  edit(eerste, w.x, ud, 'RUIL', 'ruil tussen AIOS', w.y, '2094-06-02T09:00:00.000Z', w.y);
  // Another period's change is not in it.
  w.andere = periode(`AiosWjAnder-${tag}`);
  const anderDd = slot(w.andere, 'DD', '2094-07-10');
  const anderToewijzing = insert('dienstrooster_assignment', { schedule_version_id: w.andere, person_id: w.y, slot_id: anderDd, bron: 'MANUAL', row_version: 1, aangemaakt_op: now });
  insert('dienstrooster_assignment_edit', {
    toewijzing_id: anderToewijzing,
    periode_id: w.andere,
    person_id: w.y,
    slot_id: anderDd,
    edit_type: 'HANDMATIG_TOEWIJZEN',
    reden: 'andere periode',
    bewerkt_door_person_id: w.planner,
    aangemaakt_op: '2094-06-03T09:00:00.000Z',
    row_version: 1,
  });
});

afterAll(() => deleteRowsAfter(snapshot));

describe('the AIOS wijzigingsgeschiedenis', () => {
  it('every change by hand and swap of the quarter, in order, with reason and who did it', async () => {
    const res = await download(w.period, staffCookie(w.planner));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    const rows = readFirstSheet(Buffer.from(await res.arrayBuffer()));
    expect(rows[0]).toEqual(['Datum wijziging', 'Actie', 'Betreft', 'Was', 'Dienstdatum', 'Dienst', 'Reden', 'Aangepast door']);
    expect(rows).toHaveLength(4);
    const [verwijderd, toegewezen, geruild] = rows.slice(1);
    expect(verwijderd.slice(1, 3)).toEqual(['Verwijderd', cn('y')]);
    expect(verwijderd[6]).toBe('y is ziek');
    expect(toegewezen.slice(1, 3)).toEqual(['Toegewezen', cn('x')]);
    expect(excelSerialToDate(Number(toegewezen[4]))).toBe('2094-07-10');
    expect(toegewezen[5]).toMatch(/^DD /);
    expect(geruild.slice(1, 4)).toEqual(['Geruild', cn('x'), cn('y')]);
    expect(geruild[7]).toBe(cn('y'));
    // Nothing of the other period.
    expect(rows.flat()).not.toContain('andere periode');
  });

  it("is the AIOS's planner's: the achterwacht's planner and a participant get nothing", async () => {
    expect((await download(w.period, staffCookie(staf.planner))).status).toBe(404);
    expect([401, 403]).toContain((await download(w.period, personCookie(w.x))).status);
  });
});
