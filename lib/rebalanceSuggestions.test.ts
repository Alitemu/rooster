import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { suggestRebalances } from '@/lib/rebalanceSuggestions';

/**
 * suggestRebalances proposes moving a dienst from someone over their
 * streefbereik to someone who still has room, without ever crossing a
 * hard block or double-booking a day - deliberately treating the window
 * rule as a non-veto, exactly like a planner's own manual reassign
 * already does (see lib/rosterGaps.ts's getEligiblePeopleForSlot).
 */

interface Ctx {
  poolId: string;
  avondTypeId: string;
  weekendTypeId: string;
}

const createdPeriodIds: string[] = [];
const createdPoolIds: string[] = [];
const createdPersonIds: string[] = [];

function createPool(config: Record<string, unknown>): Ctx {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Test ruleset', JSON.stringify(config));

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Test pool', rulesetId);
  createdPoolIds.push(poolId);

  const avondTypeId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`
  ).run(avondTypeId, poolId);

  const weekendTypeId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Weekend', 'WEEKEND')`
  ).run(weekendTypeId, poolId);

  return { poolId, avondTypeId, weekendTypeId };
}

function addPerson(poolId: string, codenaam: string): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op)
     VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
  ).run(personId, codenaam);
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
  ).run(crypto.randomUUID(), personId, poolId);
  createdPersonIds.push(personId);
  return personId;
}

function createPeriod(ctx: Ctx, startDate: string, endDate: string, frozen: Record<string, unknown>): string {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'P', ?, ?, '2099-01-01T00:00:00Z', 'GEGENEREERD', ?, datetime('now'))`
  ).run(periodId, ctx.poolId, startDate, endDate, JSON.stringify(frozen));
  createdPeriodIds.push(periodId);
  return periodId;
}

/** One exact slot on `datum` - full control over dates, unlike generateSlotsForPeriod. */
function slot(periodId: string, shiftTypeId: string, datum: string, isoYear: number, isoWeek: number): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot
       (id, period_id, shift_type_id, datum, iso_jaar, iso_week, is_feestdag, benodigd_aantal_personen)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1)`
  ).run(id, periodId, shiftTypeId, datum, isoYear, isoWeek);
  return id;
}

function assign(periodId: string, personId: string, slotId: string): void {
  db.prepare(
    `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
  ).run(crypto.randomUUID(), periodId, personId, slotId);
}

function block(personId: string, slotId: string, level: 'ABSOLUUT' | 'LIEVER_NIET'): void {
  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'MANUAL', datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId, level);
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare(
      `DELETE FROM dienstrooster_availability WHERE slot_id IN
         (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)`
    ).run(periodId);
    db.prepare('DELETE FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
  while (createdPoolIds.length > 0) {
    const poolId = createdPoolIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as
      | { ruleset_id: string }
      | undefined;
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
});

describe('suggestRebalances', () => {
  const START = '2027-01-04';
  const END = '2027-01-31';

  it('proposes moving a dienst from someone over their bereik to someone with room', () => {
    const ctx = createPool({ bandAvond: [1, 1] });
    const periodId = createPeriod(ctx, START, END, { bandAvond: [1, 1] });
    const a = addPerson(ctx.poolId, 'Persoon-A');
    const b = addPerson(ctx.poolId, 'Persoon-B');

    const s1 = slot(periodId, ctx.avondTypeId, '2027-01-04', 2027, 1);
    const s2 = slot(periodId, ctx.avondTypeId, '2027-01-11', 2027, 2);
    assign(periodId, a, s1);
    assign(periodId, a, s2); // a: 2 AVOND, max 1 -> 1 over
    // b has 0 AVOND, room for 1

    const suggestions = suggestRebalances(periodId);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].from_person_id).toBe(a);
    expect(suggestions[0].to_person_id).toBe(b);
    expect(suggestions[0].category).toBe('BESCHIKBAAR');
    expect(suggestions[0].warning).toBeNull();
  });

  it('never proposes a candidate who has an ABSOLUUT block on that exact dienst', () => {
    const ctx = createPool({ bandAvond: [1, 1] });
    const periodId = createPeriod(ctx, START, END, { bandAvond: [1, 1] });
    const a = addPerson(ctx.poolId, 'Persoon-A');
    const b = addPerson(ctx.poolId, 'Persoon-B');

    const s1 = slot(periodId, ctx.avondTypeId, '2027-01-04', 2027, 1);
    const s2 = slot(periodId, ctx.avondTypeId, '2027-01-11', 2027, 2);
    assign(periodId, a, s1);
    assign(periodId, a, s2);
    // Blocked on both of a's movable diensten, so there is truly no valid destination for
    // either one - b has room, but is the only other person and is hard-blocked both days.
    block(b, s1, 'ABSOLUUT');
    block(b, s2, 'ABSOLUUT');

    const suggestions = suggestRebalances(periodId);

    expect(suggestions).toHaveLength(0);
  });

  it('prefers an available candidate over one who marked the day liever niet', () => {
    const ctx = createPool({ bandAvond: [1, 1] });
    const periodId = createPeriod(ctx, START, END, { bandAvond: [1, 1] });
    const a = addPerson(ctx.poolId, 'Persoon-A');
    const b = addPerson(ctx.poolId, 'Persoon-B-lievernieter');
    const c = addPerson(ctx.poolId, 'Persoon-C-beschikbaar');

    const s1 = slot(periodId, ctx.avondTypeId, '2027-01-04', 2027, 1);
    const s2 = slot(periodId, ctx.avondTypeId, '2027-01-11', 2027, 2);
    assign(periodId, a, s1);
    assign(periodId, a, s2);
    // Blocked on both of a's movable diensten, so b reads LIEVER_NIET no matter which one is
    // tried - both b and c have room, only b marked either day liever niet.
    block(b, s1, 'LIEVER_NIET');
    block(b, s2, 'LIEVER_NIET');

    const suggestions = suggestRebalances(periodId);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].to_person_id).toBe(c);
    expect(suggestions[0].category).toBe('BESCHIKBAAR');
  });

  it('still proposes a liever-niet candidate, with a warning, when nobody else has room', () => {
    const ctx = createPool({ bandAvond: [1, 1] });
    const periodId = createPeriod(ctx, START, END, { bandAvond: [1, 1] });
    const a = addPerson(ctx.poolId, 'Persoon-A');
    const b = addPerson(ctx.poolId, 'Persoon-B');

    const s1 = slot(periodId, ctx.avondTypeId, '2027-01-04', 2027, 1);
    const s2 = slot(periodId, ctx.avondTypeId, '2027-01-11', 2027, 2);
    assign(periodId, a, s1);
    assign(periodId, a, s2);
    // Blocked on both of a's movable diensten, so b reads LIEVER_NIET no matter which one is
    // tried - b has 0 assigned (room for 1), but is the only other person in the pool.
    block(b, s1, 'LIEVER_NIET');
    block(b, s2, 'LIEVER_NIET');

    const suggestions = suggestRebalances(periodId);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].to_person_id).toBe(b);
    expect(suggestions[0].category).toBe('LIEVER_NIET');
    expect(suggestions[0].warning).toContain('liever-niet');
  });

  it('allows breaking the window rule for the recipient, with a warning, since it is not a veto here', () => {
    const ctx = createPool({ bandAvond: [1, 2], windowWeeks: 4 });
    const periodId = createPeriod(ctx, START, END, { bandAvond: [1, 2], windowWeeks: 4 });
    const a = addPerson(ctx.poolId, 'Persoon-A');
    const b = addPerson(ctx.poolId, 'Persoon-B');

    const s1 = slot(periodId, ctx.avondTypeId, '2027-01-04', 2027, 1);
    const s2 = slot(periodId, ctx.avondTypeId, '2027-01-05', 2027, 1);
    const s3 = slot(periodId, ctx.avondTypeId, '2027-01-11', 2027, 2);
    const bOwnSlot = slot(periodId, ctx.avondTypeId, '2027-01-06', 2027, 1);
    assign(periodId, a, s1);
    assign(periodId, a, s2);
    assign(periodId, a, s3); // a: 3 AVOND, max 2 -> 1 over
    assign(periodId, b, bOwnSlot); // b's own shift in week 1 - a 4-week window blocks weeks 1-4 for a new one

    const suggestions = suggestRebalances(periodId);

    // b has room (1 assigned, max 2, room 1) and is the only other person - every one of a's
    // slots falls inside b's own 4-week window, so the move must still be proposed anyway.
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].to_person_id).toBe(b);
    expect(suggestions[0].category).toBe('VENSTERBLOK');
    expect(suggestions[0].warning).toContain('vensterblok');
  });

  it('never proposes a candidate already assigned to a different dienst on the exact same day', () => {
    const ctx = createPool({ bandAvond: [1, 1], bandWeekend: [0, 5] });
    const periodId = createPeriod(ctx, START, END, { bandAvond: [1, 1], bandWeekend: [0, 5] });
    const a = addPerson(ctx.poolId, 'Persoon-A');
    const b = addPerson(ctx.poolId, 'Persoon-B');

    const s1 = slot(periodId, ctx.avondTypeId, '2027-01-04', 2027, 1);
    const s2 = slot(periodId, ctx.avondTypeId, '2027-01-09', 2027, 2);
    // b already works both of a's exact calendar dates (a different dienst/teller each time),
    // so neither of a's movable diensten has anywhere to go, whichever gets tried first.
    const s1Weekend = slot(periodId, ctx.weekendTypeId, '2027-01-04', 2027, 1);
    const s2Weekend = slot(periodId, ctx.weekendTypeId, '2027-01-09', 2027, 2);
    assign(periodId, a, s1);
    assign(periodId, a, s2); // a: 2 AVOND, max 1 -> 1 over
    assign(periodId, b, s1Weekend);
    assign(periodId, b, s2Weekend);

    const suggestions = suggestRebalances(periodId);

    // b has AVOND room but is already booked on 2027-01-09 - must not be double-booked.
    expect(suggestions).toHaveLength(0);
  });

  it('never suggests a recipient more diensten than their own remaining room', () => {
    const ctx = createPool({ bandAvond: [1, 1] });
    const periodId = createPeriod(ctx, START, END, { bandAvond: [1, 1] });
    const a1 = addPerson(ctx.poolId, 'Persoon-A1');
    const a2 = addPerson(ctx.poolId, 'Persoon-A2');
    const b = addPerson(ctx.poolId, 'Persoon-B');

    const sA1a = slot(periodId, ctx.avondTypeId, '2027-01-04', 2027, 1);
    const sA1b = slot(periodId, ctx.avondTypeId, '2027-01-11', 2027, 2);
    const sA2a = slot(periodId, ctx.avondTypeId, '2027-01-18', 2027, 3);
    const sA2b = slot(periodId, ctx.avondTypeId, '2027-01-25', 2027, 4);
    assign(periodId, a1, sA1a);
    assign(periodId, a1, sA1b); // a1: 1 over
    assign(periodId, a2, sA2a);
    assign(periodId, a2, sA2b); // a2: 1 over
    // b: 0 assigned, max 1 -> room for exactly 1, not both

    const suggestions = suggestRebalances(periodId);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].to_person_id).toBe(b);
  });

  it('returns no suggestions when nobody has room, even if someone is over their bereik', () => {
    const ctx = createPool({ bandAvond: [2, 2] });
    const periodId = createPeriod(ctx, START, END, { bandAvond: [2, 2] });
    const a = addPerson(ctx.poolId, 'Persoon-A');
    const b = addPerson(ctx.poolId, 'Persoon-B');

    const s1 = slot(periodId, ctx.avondTypeId, '2027-01-04', 2027, 1);
    const s2 = slot(periodId, ctx.avondTypeId, '2027-01-11', 2027, 2);
    const s3 = slot(periodId, ctx.avondTypeId, '2027-01-18', 2027, 3);
    const s4 = slot(periodId, ctx.avondTypeId, '2027-01-25', 2027, 4);
    assign(periodId, a, s1);
    assign(periodId, a, s2);
    assign(periodId, a, s3); // a: 3 AVOND, max 2 -> 1 over
    assign(periodId, b, s4); // b: 1 AVOND, max 2 - still room actually...

    // Give b a second dienst too, so b is exactly at max (no room left).
    const s5 = slot(periodId, ctx.avondTypeId, '2027-02-01', 2027, 5);
    assign(periodId, b, s5);

    const suggestions = suggestRebalances(periodId);

    expect(suggestions).toHaveLength(0);
  });
});
