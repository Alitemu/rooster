import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { checkSwapWindowRule } from './swapWindowRule';

/**
 * The hard rule: a swap can never leave someone with two shifts closer
 * together than the window allows.
 *
 * The solver may not break this rule, and lib/windowRule.ts is
 * informational only because a planner overriding it does so knowingly. A
 * swap between two participants has no planner in it, so it has to be
 * refused rather than warned about - otherwise the published roster can
 * end up violating the one constraint the whole schedule is built on, with
 * nothing reporting it.
 */

const created = {
  periods: [] as string[],
  pools: [] as string[],
  rulesets: [] as string[],
  people: [] as string[],
  shiftTypes: [] as string[],
};

const WINDOW_WEEKS = 2;

function createPool(): string {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Window test', JSON.stringify({ windowWeeks: WINDOW_WEEKS }));
  created.rulesets.push(rulesetId);

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Window pool', rulesetId);
  created.pools.push(poolId);
  return poolId;
}

function createPerson(): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op)
     VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
  ).run(personId, `W-${personId.slice(0, 8)}`);
  created.people.push(personId);
  return personId;
}

function createPeriod(poolId: string): string {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'W', '2027-01-04', '2027-03-28', '2026-12-01T00:00:00Z', 'GEPUBLICEERD', ?, datetime('now'))`
  ).run(periodId, poolId, JSON.stringify({ windowWeeks: WINDOW_WEEKS }));
  created.periods.push(periodId);
  return periodId;
}

function createShiftType(poolId: string, teller: 'AVOND' | 'WEEKEND'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, ?, ?)`
  ).run(id, poolId, `${teller}-${id.slice(0, 6)}`, teller);
  created.shiftTypes.push(id);
  return id;
}

/** A slot in a given ISO week, assigned to `personId`. */
function createAssignedSlot(
  periodId: string,
  shiftTypeId: string,
  isoWeek: number,
  datum: string,
  personId: string
): string {
  const slotId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
     VALUES (?, ?, ?, ?, 2027, ?)`
  ).run(slotId, periodId, shiftTypeId, datum, isoWeek);

  db.prepare(
    `INSERT INTO dienstrooster_assignment (id, schedule_version_id, slot_id, person_id, bron, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'SOLVER', datetime('now'))`
  ).run(crypto.randomUUID(), periodId, slotId, personId);
  return slotId;
}

afterEach(() => {
  for (const periodId of created.periods) {
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  for (const id of created.shiftTypes) db.prepare('DELETE FROM dienstrooster_shift_type WHERE id = ?').run(id);
  for (const id of created.people) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  for (const id of created.pools) db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  for (const id of created.rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
  created.periods = [];
  created.shiftTypes = [];
  created.people = [];
  created.pools = [];
  created.rulesets = [];
});

describe('checkSwapWindowRule', () => {
  it('refuses a swap that would put the requester two shifts one week apart', () => {
    const poolId = createPool();
    const periodId = createPeriod(poolId);
    const avond = createShiftType(poolId, 'AVOND');
    const alice = createPerson();
    const bob = createPerson();

    // Alice keeps a shift in week 10 and offers her week 2 one; the shift
    // she would receive sits in week 11 - one week from the one she keeps,
    // inside a two-week window.
    createAssignedSlot(periodId, avond, 10, '2027-03-08', alice);
    const offered = createAssignedSlot(periodId, avond, 2, '2027-01-11', alice);
    const requested = createAssignedSlot(periodId, avond, 11, '2027-03-15', bob);

    const result = checkSwapWindowRule({
      periodId,
      requesterPersonId: alice,
      respondentPersonId: bob,
      offeredSlotId: offered,
      requestedSlotId: requested,
    });

    expect(result.allowed).toBe(false);
    expect(result.message).toContain('planner');
  });

  it('refuses it the other way round too, when the respondent is the one who ends up too close', () => {
    const poolId = createPool();
    const periodId = createPeriod(poolId);
    const avond = createShiftType(poolId, 'AVOND');
    const alice = createPerson();
    const bob = createPerson();

    const offered = createAssignedSlot(periodId, avond, 5, '2027-02-01', alice);
    const requested = createAssignedSlot(periodId, avond, 20, '2027-05-17', bob);
    createAssignedSlot(periodId, avond, 6, '2027-02-08', bob); // Bob's other shift

    const result = checkSwapWindowRule({
      periodId,
      requesterPersonId: alice,
      respondentPersonId: bob,
      offeredSlotId: offered,
      requestedSlotId: requested,
    });

    expect(result.allowed).toBe(false);
  });

  it('allows a swap where both people stay far enough from their other shifts', () => {
    const poolId = createPool();
    const periodId = createPeriod(poolId);
    const avond = createShiftType(poolId, 'AVOND');
    const alice = createPerson();
    const bob = createPerson();

    createAssignedSlot(periodId, avond, 2, '2027-01-11', alice);
    const offered = createAssignedSlot(periodId, avond, 10, '2027-03-08', alice);
    const requested = createAssignedSlot(periodId, avond, 20, '2027-05-17', bob);

    const result = checkSwapWindowRule({
      periodId,
      requesterPersonId: alice,
      respondentPersonId: bob,
      offeredSlotId: offered,
      requestedSlotId: requested,
    });

    expect(result.allowed).toBe(true);
  });

  it('does not count the shift someone is giving up as a conflict with itself', () => {
    // The two slots being traded are one week apart, which would look like
    // a violation if the outgoing shift were still counted. After the swap
    // neither person holds both, so it is fine.
    const poolId = createPool();
    const periodId = createPeriod(poolId);
    const avond = createShiftType(poolId, 'AVOND');
    const alice = createPerson();
    const bob = createPerson();

    const offered = createAssignedSlot(periodId, avond, 10, '2027-03-08', alice);
    const requested = createAssignedSlot(periodId, avond, 11, '2027-03-15', bob);

    const result = checkSwapWindowRule({
      periodId,
      requesterPersonId: alice,
      respondentPersonId: bob,
      offeredSlotId: offered,
      requestedSlotId: requested,
    });

    expect(result.allowed).toBe(true);
  });

  it('measures across a year boundary in calendar weeks, not by subtracting week numbers', () => {
    // 2026 is a 53-week ISO year, so its week 53 is the week directly
    // before week 1 of 2027 - one week apart, not 52. Subtracting the week
    // numbers would give a gap of 52 and wave this straight through.
    const poolId = createPool();
    const periodId = createPeriod(poolId);
    const avond = createShiftType(poolId, 'AVOND');
    const alice = createPerson();
    const bob = createPerson();

    const lastYear = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
       VALUES (?, ?, ?, '2026-12-28', 2026, 53)`
    ).run(lastYear, periodId, avond);
    db.prepare(
      `INSERT INTO dienstrooster_assignment (id, schedule_version_id, slot_id, person_id, bron, aangemaakt_op)
       VALUES (?, ?, ?, ?, 'SOLVER', datetime('now'))`
    ).run(crypto.randomUUID(), periodId, lastYear, alice);

    const offered = createAssignedSlot(periodId, avond, 20, '2027-05-17', alice);
    const requested = createAssignedSlot(periodId, avond, 1, '2027-01-04', bob);

    const result = checkSwapWindowRule({
      periodId,
      requesterPersonId: alice,
      respondentPersonId: bob,
      offeredSlotId: offered,
      requestedSlotId: requested,
    });

    expect(result.allowed).toBe(false);
  });
});
