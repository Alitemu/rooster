import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { db } from '@/db/client';
import { personWouldViolateWindowRule, getWindowConflictingPersonIds } from '@/lib/windowRule';
import { swapWindowConflicts } from '@/lib/swapWindowRule';
import { softDeletePeriod } from '@/lib/periodTrash';

/**
 * The rule: the window rule holds across the boundary between periods, in
 * what a planner or participant is warned about too (audit 11).
 *
 * The solver and the publication check already looked across it (the
 * previous roster's last weeks, "Eerdere toewijzingen"), but the warnings
 * a person sees while acting looked only inside the period: a planner
 * filling week 1 by hand was offered, without "venster", someone who
 * worked the last Sunday before it - and only the publication check
 * complained afterwards; a swap in a period's last week said nothing about
 * a shift in the next period's first. Now they look at the person's shifts
 * in every period of the pool (outside the prullenbak) and at the
 * period's own "Eerdere toewijzingen" (history from before the app).
 *
 * A window of two weeks: at most one shift in any two consecutive ISO
 * weeks. P0 (published) is ISO weeks 2-3 of 2035, P1 weeks 4-5, P2 weeks
 * 6-7.
 */

const RULES = { windowWeeks: 2, bandAvond: [0, 9], bandWeekend: [0, 9], bandFeestdag: [0, 9] };
const W = { avond: 2, weekendFeestdag: 2 };
const ids: Record<string, string> = {};
const slots: Record<string, { id: string; week: number }> = {};
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

/** A two-week period from ISO week `week` of 2035 (its Monday is `start`), one avonddienst per week. */
function period(pool: string, name: string, start: string, week: number, status: string): string {
  const now = new Date().toISOString();
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + 13 * 86400000).toISOString().slice(0, 10);
  const id = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: name,
    start_datum: start,
    eind_datum: end,
    deadline: '2030-12-01T12:00:00.000Z',
    status,
    bevroren_ruleset_json: JSON.stringify(RULES),
    aangemaakt_op: now,
  });
  for (let i = 0; i < 2; i++) {
    const datum = new Date(Date.parse(`${start}T00:00:00Z`) + (7 * i + 2) * 86400000).toISOString().slice(0, 10);
    slots[`${name}-${i}`] = {
      id: insert('dienstrooster_shift_slot', { period_id: id, shift_type_id: ids.avond, datum, iso_jaar: 2035, iso_week: week + i, is_feestdag: 0, benodigd_aantal_personen: 1 }),
      week: week + i,
    };
  }
  return id;
}

function assign(periodId: string, slot: string, who: string): void {
  insert('dienstrooster_assignment', { schedule_version_id: periodId, person_id: ids[who], slot_id: slots[slot].id, bron: 'SOLVER', row_version: 1, aangemaakt_op: new Date().toISOString() });
}

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Grens', config_json: JSON.stringify(RULES), aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Grens', ruleset_id: ruleset, aangemaakt_op: now });
  ids.other = insert('dienstrooster_pool', { naam: 'Andere pool', ruleset_id: ruleset, aangemaakt_op: now });
  ids.avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  for (const who of ['A', 'B', 'C', 'D', 'E']) {
    ids[who] = insert('dienstrooster_person', { codenaam: `Grens-${who}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: ids[who], pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Grens-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });

  ids.p0 = period(ids.pool, 'P0', '2035-01-08', 2, 'GEPUBLICEERD');
  ids.p1 = period(ids.pool, 'P1', '2035-01-22', 4, 'GEGENEREERD');
  ids.p2 = period(ids.pool, 'P2', '2035-02-05', 6, 'GEGENEREERD');
  ids.trashed = period(ids.pool, 'Weg', '2035-01-22', 4, 'GEPUBLICEERD');
  ids.elsewhere = period(ids.other, 'Elders', '2035-01-08', 2, 'GEPUBLICEERD');

  assign(ids.p0, 'P0-1', 'A'); // A: the last week before P1
  assign(ids.p1, 'P1-1', 'B'); // B: P1's last week ...
  assign(ids.p2, 'P2-0', 'C'); // C: P2's first week
  assign(ids.p1, 'P1-0', 'D');
  assign(ids.trashed, 'Weg-0', 'E'); // E: only in a period in the prullenbak ...
  softDeletePeriod(ids.trashed, ids.planner);
  assign(ids.elsewhere, 'Elders-1', 'E'); // ... and in another pool
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('the window rule warns across the boundary between periods', () => {
  it('a shift in the last week of the period before', () => {
    expect(personWouldViolateWindowRule(ids.p1, ids.A, 2035, 4, 'AVOND', W)).toBe(true);
    expect(getWindowConflictingPersonIds(ids.p1, 2035, 4, 'AVOND', W)).toContain(ids.A);
    // Two weeks on it is fine again.
    expect(personWouldViolateWindowRule(ids.p1, ids.A, 2035, 5, 'AVOND', W)).toBe(false);
  });

  it('a shift in the first week of the period after', () => {
    expect(personWouldViolateWindowRule(ids.p1, ids.C, 2035, 5, 'AVOND', W)).toBe(true);
    expect(getWindowConflictingPersonIds(ids.p1, 2035, 5, 'AVOND', W)).toContain(ids.C);
  });

  it('history from before the app, in "Eerdere toewijzingen"', () => {
    const now = new Date().toISOString();
    insert('dienstrooster_prior_assignment', {
      period_id: ids.p1,
      datum: '2035-01-20',
      iso_jaar: 2035,
      iso_week: 3,
      teller: 'AVOND',
      person_id: ids.D,
      bron: 'HANDMATIG',
      aangemaakt_door: ids.planner,
      aangemaakt_op: now,
    });
    expect(personWouldViolateWindowRule(ids.p1, ids.D, 2035, 4, 'AVOND', W, slots['P1-0'].id)).toBe(true);
  });

  it('not from a period in the prullenbak, nor from another pool', () => {
    expect(personWouldViolateWindowRule(ids.p1, ids.E, 2035, 4, 'AVOND', W)).toBe(false);
    expect(getWindowConflictingPersonIds(ids.p1, 2035, 4, 'AVOND', W)).not.toContain(ids.E);
  });

  it('a swap in the last week warns about the next period', () => {
    // B offers C their shift in P1's last week (week 5) for one of P1's
    // first week: C would have week 5 right before their own week 6 in P2.
    const conflicts = swapWindowConflicts({
      periodId: ids.p1,
      requesterPersonId: ids.B,
      respondentPersonId: ids.C,
      offeredSlotId: slots['P1-1'].id,
      requestedSlotId: slots['P1-0'].id,
    });
    expect(conflicts.respondentTooClose).toBe(true);
  });
});
