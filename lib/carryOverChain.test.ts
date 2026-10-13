import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { db } from '@/db/client';
import { refreshCarryOverForPeriod } from '@/lib/carryOver';

/**
 * The rule: what someone did in a period reaches the next period's
 * balance once - never twice.
 *
 * Carry-over is booked from "the most recent published period before
 * this one" (findPreviousPublishedPeriod), and since 0.13.0 again at every
 * generation. When the period right before is withdrawn for a correction
 * (unpublished) while the one after it is generated, that lookup skips it
 * and lands on the period before that - whose imbalance was already carried
 * into the withdrawn one. Audit 9.
 *
 * Three periods, two people, a band of exactly two avonddiensten:
 * - P0: A did 3, B did 1, so P1 carries A one fewer and B one more;
 * - P1: A did 1, B did 3 - exactly their targets, nothing left over;
 * - P2: nothing to carry. Withdrawing P1 must not change that.
 */

const RULES = { windowWeeks: 0, bandAvond: [2, 2], bandWeekend: [0, 0], bandFeestdag: [0, 0] };
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

/** A two-week period starting on `start` (a Monday) with one avonddienst per weekday owner listed. */
function period(start: string, status: string, owners: string[]): string {
  const now = new Date().toISOString();
  const id = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: `Keten ${start}`,
    start_datum: start,
    eind_datum: new Date(Date.parse(`${start}T00:00:00Z`) + 13 * 86400000).toISOString().slice(0, 10),
    deadline: '2030-12-01T12:00:00.000Z',
    status,
    bevroren_ruleset_json: JSON.stringify(RULES),
    aangemaakt_op: now,
    overloop_bevestigd_op: now,
    ...(status === 'GEPUBLICEERD' ? { gepubliceerd_op: now, definitief_op: now } : {}),
  });
  owners.forEach((who, d) => {
    const datum = new Date(Date.parse(`${start}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
    const slot = insert('dienstrooster_shift_slot', { period_id: id, shift_type_id: ids.avond, datum, iso_jaar: 2032, iso_week: 1, is_feestdag: 0, benodigd_aantal_personen: 1 });
    insert('dienstrooster_assignment', { schedule_version_id: id, person_id: ids[who], slot_id: slot, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  });
  return id;
}

const carry = (periodId: string) =>
  Object.fromEntries(
    (
      db
        .prepare(`SELECT person_id, SUM(delta) AS d FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ? AND categorie = 'CARRY_OVER' GROUP BY person_id`)
        .all(periodId) as Array<{ person_id: string; d: number }>
    ).map((r) => [r.person_id === ids.A ? 'A' : 'B', r.d])
  );

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Keten', config_json: JSON.stringify(RULES), aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Keten', ruleset_id: ruleset, aangemaakt_op: now });
  ids.avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  for (const who of ['A', 'B']) {
    ids[who] = insert('dienstrooster_person', { codenaam: `Keten-${who}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: ids[who], pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Keten-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('carry-over over a chain of periods', () => {
  it('books each period once, also while the one in between is withdrawn', () => {
    period('2032-01-05', 'GEPUBLICEERD', ['A', 'A', 'A', 'B']);
    const p1 = period('2032-01-19', 'GEPUBLICEERD', ['A', 'B', 'B', 'B']);
    // Book P1 as the open route did: from P0.
    refreshCarryOverForPeriod(p1, ids.planner);
    expect(carry(p1)).toEqual({ A: -1, B: 1 });

    const p2 = period('2032-02-02', 'GESLOTEN', []);
    refreshCarryOverForPeriod(p2, ids.planner);
    expect(carry(p2)).toEqual({});
  });

  // Audit 9: with P1 withdrawn, P2's generation books P0's imbalance a
  // second time: { A: -1, B: 1 }.
  it.fails('withdrawing the period in between does not bring the one before it back', () => {
    const p2 = (db.prepare(`SELECT id FROM dienstrooster_schedule_period WHERE naam = 'Keten 2032-02-02'`).get() as { id: string }).id;
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD', gepubliceerd_op = NULL, definitief_op = NULL WHERE naam = 'Keten 2032-01-19'`).run();
    refreshCarryOverForPeriod(p2, ids.planner);
    expect(carry(p2)).toEqual({});
  });
});
