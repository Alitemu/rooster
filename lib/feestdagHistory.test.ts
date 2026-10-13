import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { db } from '@/db/client';
import { feestdagAchterstand, feestdagTargets } from '@/lib/feestdagHistory';
import { softDeletePeriod } from '@/lib/periodTrash';

/**
 * The rule: over the years everyone gets about as many feestdagdiensten,
 * in proportion to the time they took part - the number, not which
 * feestdag (the planner, after audit 10). What someone is behind is their
 * fair share of every earlier published period's feestdagdiensten minus
 * what they did; the target sent to the solver adds this period's share.
 *
 * Four people, A to D, members the whole time unless said otherwise.
 */

const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;
let pool = '';

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

const addDays = (datum: string, n: number) => new Date(Date.parse(`${datum}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function newPool(): void {
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Feestdagen', config_json: '{}', aangemaakt_op: now });
  pool = insert('dienstrooster_pool', { naam: 'Feestdagen', ruleset_id: ruleset, aangemaakt_op: now });
  ids.feestdag = insert('dienstrooster_shift_type', { pool_id: pool, naam: 'Feestdag', teller: 'FEESTDAG' });
  ids.avond = insert('dienstrooster_shift_type', { pool_id: pool, naam: 'Avond', teller: 'AVOND' });
}

function member(who: string, vanaf = '2020-01-01', tot = '2100-12-31', factor = 1): void {
  insert('dienstrooster_pool_membership', { person_id: ids[who], pool_id: pool, deelnamefactor: factor, geldig_vanaf: vanaf, geldig_tot: tot });
}

/**
 * A four-week period from `start` (a Monday). `feestdagen` lists who did
 * each of its feestdagdiensten (null: nobody); an avonddienst on the first
 * day shows the other tellers don't count.
 */
function period(start: string, status: string, feestdagen: Array<string | null>, rules: Record<string, unknown> = {}): string {
  const now = new Date().toISOString();
  const id = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: `Feestdagen ${start}`,
    start_datum: start,
    eind_datum: addDays(start, 27),
    deadline: '2030-12-01T12:00:00.000Z',
    status,
    bevroren_ruleset_json: JSON.stringify({ windowWeeks: 0, ...rules }),
    aangemaakt_op: now,
    ...(status === 'GEPUBLICEERD' ? { gepubliceerd_op: now, definitief_op: now } : {}),
  });
  const avond = insert('dienstrooster_shift_slot', { period_id: id, shift_type_id: ids.avond, datum: start, iso_jaar: 2034, iso_week: 1, is_feestdag: 0, benodigd_aantal_personen: 1 });
  insert('dienstrooster_assignment', { schedule_version_id: id, person_id: ids.A, slot_id: avond, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  feestdagen.forEach((who, i) => {
    const slot = insert('dienstrooster_shift_slot', {
      period_id: id,
      shift_type_id: ids.feestdag,
      datum: addDays(start, 7 * i + 1),
      iso_jaar: 2034,
      iso_week: 1 + i,
      is_feestdag: 1,
      feestdag_groep: 'PASEN',
      benodigd_aantal_personen: 1,
    });
    if (who) insert('dienstrooster_assignment', { schedule_version_id: id, person_id: ids[who], slot_id: slot, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  });
  return id;
}

const named = (map: Map<string, number> | Record<string, number>) =>
  Object.fromEntries(
    (map instanceof Map ? [...map] : Object.entries(map))
      .map(([id, v]) => [Object.keys(ids).find((k) => ids[k] === id) ?? id, Math.round(v * 100) / 100])
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
  );

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  for (const who of ['A', 'B', 'C', 'D', 'E']) {
    ids[who] = insert('dienstrooster_person', { codenaam: `Feestdag-${who}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Feestdag-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('feestdagdiensten over the years', () => {
  it('remembers who had them, period after period, and the next target says so', () => {
    newPool();
    for (const who of ['A', 'B', 'C', 'D']) member(who);
    // P0: 2 for 4 people, half each by right; A and B had them.
    period('2034-01-02', 'GEPUBLICEERD', ['A', 'B']);
    // P1: the same; A and C had them.
    period('2034-02-06', 'GEPUBLICEERD', ['A', 'C']);
    const p2 = period('2034-03-06', 'GESLOTEN', [null, null, null, null]);

    expect(named(feestdagAchterstand(pool, '2034-03-06'))).toEqual({ A: -1, B: 0, C: 0, D: 1 });
    // P2 has 4: one each by right, plus what they are behind.
    expect(named(feestdagTargets(p2))).toEqual({ A: 0, B: 1, C: 1, D: 2 });
  });

  it('measures someone who took part for part of the time by that part', () => {
    newPool();
    for (const who of ['A', 'B', 'C']) member(who);
    // E joined halfway P0 (two of its four weeks).
    member('E', '2034-01-16');
    // 3 feestdagdiensten shared by 3.5 people: 6/7 each, 3/7 for E.
    period('2034-01-02', 'GEPUBLICEERD', ['A', 'B', 'C']);
    expect(named(feestdagAchterstand(pool, '2034-02-06'))).toEqual({ A: -0.14, B: -0.14, C: -0.14, E: 0.43 });
  });

  it('weighs the deelnamefactor under NAAR_RATO, not under GELIJK', () => {
    newPool();
    member('A');
    member('B', '2020-01-01', '2100-12-31', 0.5);
    period('2034-01-02', 'GEPUBLICEERD', ['A', 'A', 'A'], { distributionMode: 'NAAR_RATO' });
    // 3 shared by 1.5: A 2 by right, B 1; A did 3.
    expect(named(feestdagAchterstand(pool, '2034-02-06'))).toEqual({ A: -1, B: 1 });
    period('2034-02-06', 'GEPUBLICEERD', ['B', 'B'], { distributionMode: 'GELIJK' });
    // Then 2 shared equally: 1 each by right; B did both.
    expect(named(feestdagAchterstand(pool, '2034-03-06'))).toEqual({ A: 0, B: 0 });
  });

  it('counts only published periods outside the prullenbak, of this pool, before this one', () => {
    newPool();
    for (const who of ['A', 'B']) member(who);
    const trashed = period('2034-01-02', 'GEPUBLICEERD', ['A', 'A']);
    softDeletePeriod(trashed, ids.planner);
    period('2034-02-06', 'GEGENEREERD', ['A', 'A']);
    const p = period('2034-03-06', 'GESLOTEN', [null, null]);
    period('2034-04-03', 'GEPUBLICEERD', ['B', 'B']); // after it
    expect(named(feestdagAchterstand(pool, '2034-03-06'))).toEqual({});
    // A pool's first period here: everyone even, this period's share only.
    expect(named(feestdagTargets(p))).toEqual({ A: 1, B: 1 });
  });
});
