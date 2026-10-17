import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fc from 'fast-check';
import { db } from '@/db/client';
import { POST as toewijzen } from './manual-assign/route';
import { POST as wisselen } from './[assignment-id]/reassign/route';
import { DELETE as verwijderen } from './[assignment-id]/delete/route';
import { POST as terug } from './undo-last/route';
import { deleteRowsAfter, insert, now, rowidSnapshot, staff, staffCookie, tag } from '../../../../../../tests/fixtures/dienstWorlds';

/**
 * Filling in the achterwacht's roster by hand, as a model (the full audit,
 * 0.86.0): random sequences of toewijzen, wisselen, verwijderen and
 * ongedaan maken on a generated or published roster, through the real
 * routes. After every step the roster is the model's: who holds each
 * dienst, and whether by hand or from the solver (a regeneration keeps
 * what was filled in by hand and replaces the rest). Ongedaan maken puts
 * back exactly the roster from before the last change, the source
 * included, and only once.
 */

let snapshot: Map<string, number>;
const w = {} as { pool: string; type: string; planner: string; mensen: string[] };
const DATA = ['2097-03-02', '2097-03-03', '2097-03-04', '2097-03-05'];

type Cel = { person_id: string; bron: string } | null;
type Stap =
  | { soort: 'toewijzen'; dienst: number; wie: number }
  | { soort: 'wisselen'; dienst: number; wie: number }
  | { soort: 'verwijderen'; dienst: number }
  | { soort: 'terug' };

beforeAll(() => {
  snapshot = rowidSnapshot();
  w.planner = staff('PLANNER', 'ACHTERWACHT');
  const ruleset = insert('dienstrooster_ruleset', { naam: `Handmatig-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `Handmatig-${tag}`, ruleset_id: ruleset, aangemaakt_op: now });
  w.type = insert('dienstrooster_shift_type', { pool_id: w.pool, naam: 'Avond', teller: 'AVOND' });
  w.mensen = ['a', 'b', 'c'].map((n) => {
    const id = insert('dienstrooster_person', { codenaam: `handmatig-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2097-01-01', geldig_tot: '2097-12-31' });
    return id;
  });
});

afterAll(() => deleteRowsAfter(snapshot));

/** A roster of four avonddiensten from the solver: a, b, c, a. */
function nieuwRooster(status: string): { id: string; diensten: string[] } {
  db.prepare("UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE pool_id = ? AND verwijderd_op IS NULL").run(now, w.pool);
  const id = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `Handmatig-${crypto.randomUUID().slice(0, 6)}`,
    start_datum: '2097-03-02',
    eind_datum: '2097-03-08',
    deadline: '2097-02-20T17:00:00.000Z',
    status,
    bevroren_ruleset_json: JSON.stringify({ windowWeeks: 0, bandAvond: [0, 4], bandWeekend: [0, 0], bandFeestdag: [0, 0] }),
    aangemaakt_op: now,
    ...(status === 'GEPUBLICEERD' ? { gepubliceerd_op: now } : {}),
  });
  const diensten = DATA.map((datum, i) => {
    const slot = insert('dienstrooster_shift_slot', { period_id: id, shift_type_id: w.type, datum, iso_jaar: 2097, iso_week: 10, is_feestdag: 0, benodigd_aantal_personen: 1 });
    insert('dienstrooster_assignment', { schedule_version_id: id, person_id: w.mensen[i % 3], slot_id: slot, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
    return slot;
  });
  return { id, diensten };
}

const rooster = (id: string, diensten: string[]): Cel[] =>
  diensten.map(
    (slot) =>
      (db.prepare('SELECT person_id, bron FROM dienstrooster_assignment WHERE schedule_version_id = ? AND slot_id = ?').get(id, slot) as Cel | undefined) ?? null
  );
const toewijzing = (id: string, slot: string) =>
  (db.prepare('SELECT id FROM dienstrooster_assignment WHERE schedule_version_id = ? AND slot_id = ?').get(id, slot) as { id: string } | undefined)?.id ??
  crypto.randomUUID();

const vraag = (pad: string, method: string, body: unknown) =>
  new NextRequest(`http://localhost/api/planner/period/${pad}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: staffCookie(w.planner) },
    body: JSON.stringify(body),
  });

const stap = fc.oneof(
  fc.record({ soort: fc.constant('toewijzen' as const), dienst: fc.nat(3), wie: fc.nat(2) }),
  fc.record({ soort: fc.constant('wisselen' as const), dienst: fc.nat(3), wie: fc.nat(2) }),
  fc.record({ soort: fc.constant('verwijderen' as const), dienst: fc.nat(3) }),
  fc.record({ soort: fc.constant('terug' as const) })
);

describe('the achterwacht roster filled in by hand', () => {
  it('follows the model, and ongedaan maken puts back exactly the roster before the last change', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('GEGENEREERD', 'GEPUBLICEERD'), fc.array(stap, { minLength: 1, maxLength: 15 }), async (status, stappen) => {
        const { id, diensten } = nieuwRooster(status);
        let model = rooster(id, diensten);
        let vorige: Cel[] | null = null;
        const ctx = (toe = '') => ({ params: Promise.resolve({ id, 'assignment-id': toe }) });
        for (const s of stappen as Stap[]) {
          const voor = model;
          const naam = `${s.soort} ${JSON.stringify(s)} op ${JSON.stringify(voor)}`;
          let res: Response;
          let na: Cel[] = voor;
          if (s.soort === 'toewijzen') {
            const wie = w.mensen[s.wie];
            res = await toewijzen(vraag(`${id}/assignments/manual-assign`, 'POST', { person_id: wie, slot_id: diensten[s.dienst], reason: 'Model' }), ctx());
            if (!voor[s.dienst]) na = voor.map((c, i) => (i === s.dienst ? { person_id: wie, bron: 'MANUAL' } : c));
            expect(res.status, naam).toBe(!voor[s.dienst] || voor[s.dienst]!.person_id === wie ? 200 : 409);
          } else if (s.soort === 'wisselen') {
            const wie = w.mensen[s.wie];
            const toe = toewijzing(id, diensten[s.dienst]);
            res = await wisselen(vraag(`${id}/assignments/${toe}/reassign`, 'POST', { person_id: wie, reason: 'Model' }), ctx(toe));
            if (voor[s.dienst] && voor[s.dienst]!.person_id !== wie) na = voor.map((c, i) => (i === s.dienst ? { person_id: wie, bron: 'MANUAL' } : c));
            expect(res.status, naam).toBe(voor[s.dienst] ? 200 : 404);
          } else if (s.soort === 'verwijderen') {
            const toe = toewijzing(id, diensten[s.dienst]);
            res = await verwijderen(vraag(`${id}/assignments/${toe}/delete`, 'DELETE', { reason: 'Model' }), ctx(toe));
            if (voor[s.dienst]) na = voor.map((c, i) => (i === s.dienst ? null : c));
            expect(res.status, naam).toBe(voor[s.dienst] ? 200 : 404);
          } else {
            res = await terug(vraag(`${id}/assignments/undo-last`, 'POST', { reason: 'Model' }), ctx());
            expect(res.status, naam).toBe(vorige ? 200 : 404);
            if (vorige) na = vorige;
          }
          // Ongedaan maken goes back to before the last change, once.
          if (s.soort === 'terug') vorige = null;
          else if (JSON.stringify(na) !== JSON.stringify(voor)) vorige = voor;
          model = na;
          expect(rooster(id, diensten), naam).toEqual(model);
        }
      }),
      { numRuns: 100 }
    );
  }, 120_000);
});
