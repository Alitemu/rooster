import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import {
  isoWeeksApart,
  personWouldViolateWindowRule,
  getWindowConflictingPersonIds,
} from '@/lib/windowRule';

/**
 * Window rule conflict detection - informational only (see windowRule.ts).
 * This proves the detection itself is correct, including across a year
 * boundary; it is never used to block a manual assignment.
 */

interface Fixture {
  poolId: string;
  personIds: string[];
  periodId: string;
  slotIds: string[];
}

function createFixture(personCount: number, startDate: string, endDate: string): Fixture {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Test ruleset', '{}');

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Test pool', rulesetId);

  const shiftTypeId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`
  ).run(shiftTypeId, poolId);

  const personIds: string[] = [];
  for (let i = 0; i < personCount; i++) {
    const personId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', datetime('now'))`
    ).run(personId, `Test-${personId.slice(0, 8)}`);
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
    ).run(crypto.randomUUID(), personId, poolId);
    personIds.push(personId);
  }

  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'Test period', ?, ?, '2099-01-01T00:00:00Z', 'GEGENEREERD', datetime('now'))`
  ).run(periodId, poolId, startDate, endDate);

  const slots = generateSlotsForPeriod({ startDate, endDate, shiftTypes: ['AVOND'] });
  const insertStmt = db.prepare(
    `INSERT INTO dienstrooster_shift_slot
       (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id,
        is_feestdag, feestdag_groep, benodigd_aantal_personen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  const slotIds: string[] = [];
  for (const slot of slots) {
    const id = crypto.randomUUID();
    insertStmt.run(
      id, periodId, shiftTypeId, slot.datum, slot.iso_jaar, slot.iso_week,
      slot.weekend_id || null, slot.is_feestdag ? 1 : 0, slot.feestdag_groep
    );
    slotIds.push(id);
  }

  return trackFixture({ poolId, personIds, periodId, slotIds });
}

function slotById(slotId: string): { iso_jaar: number; iso_week: number } {
  return db
    .prepare('SELECT iso_jaar, iso_week FROM dienstrooster_shift_slot WHERE id = ?')
    .get(slotId) as { iso_jaar: number; iso_week: number };
}

function assign(periodId: string, personId: string, slotId: string) {
  db.prepare(
    `INSERT INTO dienstrooster_assignment
       (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'MANUAL', 1, datetime('now'))`
  ).run(crypto.randomUUID(), periodId, personId, slotId);
}

const createdPeriodIds: string[] = [];
function trackFixture(f: Fixture): Fixture {
  createdPeriodIds.push(f.periodId);
  return f;
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    const period = db
      .prepare('SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { pool_id: string } | undefined;
    if (!period) continue;

    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
    const memberIds = db
      .prepare('SELECT person_id FROM dienstrooster_pool_membership WHERE pool_id = ?')
      .all(period.pool_id) as Array<{ person_id: string }>;
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(period.pool_id);
    for (const m of memberIds) {
      db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(m.person_id);
    }
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(period.pool_id);
    const pool = db
      .prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?')
      .get(period.pool_id) as { ruleset_id: string } | undefined;
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(period.pool_id);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
});

describe('isoWeeksApart', () => {
  it('is zero for the same iso week', () => {
    expect(isoWeeksApart(2027, 5, 2027, 5)).toBe(0);
  });

  it('counts plainly within the same year', () => {
    expect(isoWeeksApart(2027, 5, 2027, 8)).toBe(3);
    expect(isoWeeksApart(2027, 8, 2027, 5)).toBe(3); // order independent
  });

  it('counts correctly across a year boundary, unlike a bare iso_week subtraction', () => {
    // 2026 has 53 ISO weeks; week 53 of 2026 and week 1 of 2027 are one
    // calendar week apart. A bare `1 - 53 = -52` would say the opposite.
    expect(isoWeeksApart(2026, 53, 2027, 1)).toBe(1);
  });
});

describe('personWouldViolateWindowRule', () => {
  it('flags a person already assigned one week inside the window', () => {
    const f = createFixture(1, '2027-01-04', '2027-01-24'); // weeks 1-4
    const week2Slot = f.slotIds.find((id) => slotById(id).iso_week === 2)!;
    const week3Slot = f.slotIds.find((id) => slotById(id).iso_week === 3)!;
    assign(f.periodId, f.personIds[0], week2Slot);

    const target = slotById(week3Slot);
    const violates = personWouldViolateWindowRule(
      f.periodId,
      f.personIds[0],
      target.iso_jaar,
      target.iso_week,
      2 // windowWeeks
    );

    expect(violates).toBe(true);
  });

  it('allows a gap of exactly windowWeeks', () => {
    const f = createFixture(1, '2027-01-04', '2027-01-31'); // weeks 1-4
    const week2Slot = f.slotIds.find((id) => slotById(id).iso_week === 2)!;
    const week4Slot = f.slotIds.find((id) => slotById(id).iso_week === 4)!;
    assign(f.periodId, f.personIds[0], week2Slot);

    const target = slotById(week4Slot);
    const violates = personWouldViolateWindowRule(
      f.periodId,
      f.personIds[0],
      target.iso_jaar,
      target.iso_week,
      2 // windowWeeks: week 2 -> week 4 is exactly 2 weeks apart, allowed
    );

    expect(violates).toBe(false);
  });

  it('catches the conflict across a year boundary', () => {
    const f = createFixture(1, '2026-12-14', '2027-01-17'); // spans the 2026/2027 boundary
    const decSlot = f.slotIds.find((id) => {
      const s = slotById(id);
      return s.iso_jaar === 2026 && s.iso_week === 53;
    });
    const janSlot = f.slotIds.find((id) => {
      const s = slotById(id);
      return s.iso_jaar === 2027 && s.iso_week === 1;
    });
    expect(decSlot).toBeDefined();
    expect(janSlot).toBeDefined();
    assign(f.periodId, f.personIds[0], decSlot!);

    const target = slotById(janSlot!);
    const violates = personWouldViolateWindowRule(
      f.periodId,
      f.personIds[0],
      target.iso_jaar,
      target.iso_week,
      2 // windowWeeks
    );

    expect(violates).toBe(true);
  });

  it('never flags anything when windowWeeks is 0 or 1', () => {
    const f = createFixture(1, '2027-01-04', '2027-01-24');
    const week2Slot = f.slotIds.find((id) => slotById(id).iso_week === 2)!;
    const week3Slot = f.slotIds.find((id) => slotById(id).iso_week === 3)!;
    assign(f.periodId, f.personIds[0], week2Slot);

    const target = slotById(week3Slot);
    expect(
      personWouldViolateWindowRule(f.periodId, f.personIds[0], target.iso_jaar, target.iso_week, 0)
    ).toBe(false);
    expect(
      personWouldViolateWindowRule(f.periodId, f.personIds[0], target.iso_jaar, target.iso_week, 1)
    ).toBe(false);
  });

  it('excludes the slot being reassigned itself', () => {
    const f = createFixture(1, '2027-01-04', '2027-01-10'); // 1 week
    const slot = f.slotIds[0];
    assign(f.periodId, f.personIds[0], slot);
    const target = slotById(slot);

    // Without exclusion, a person's own current assignment would flag
    // itself as a conflict when re-evaluating a reassign onto the same slot.
    expect(
      personWouldViolateWindowRule(
        f.periodId,
        f.personIds[0],
        target.iso_jaar,
        target.iso_week,
        2,
        slot
      )
    ).toBe(false);
  });
});

describe('getWindowConflictingPersonIds', () => {
  it('filters a candidate list down to only the people without a conflict', () => {
    const f = createFixture(3, '2027-01-04', '2027-01-24'); // weeks 1-4
    const week2Slot = f.slotIds.find((id) => slotById(id).iso_week === 2)!;
    const week3Slot = f.slotIds.find((id) => slotById(id).iso_week === 3)!;
    assign(f.periodId, f.personIds[0], week2Slot); // conflicts
    assign(f.periodId, f.personIds[1], f.slotIds.find((id) => slotById(id).iso_week === 1)!); // week 1, no conflict with week 3

    const target = slotById(week3Slot);
    const conflicting = getWindowConflictingPersonIds(
      f.periodId,
      target.iso_jaar,
      target.iso_week,
      2
    );

    expect(conflicting.has(f.personIds[0])).toBe(true);
    expect(conflicting.has(f.personIds[1])).toBe(false);
    expect(conflicting.has(f.personIds[2])).toBe(false);
  });
});
