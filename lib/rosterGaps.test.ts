import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import {
  findUnfilledSlots,
  getManuallyFilledSlotIds,
  clearSolverAssignments,
} from '@/lib/rosterGaps';

/**
 * Partial-roster / manual gap-filling rules.
 *
 * Capacity is soft in the solver, so rosters can come back with holes that
 * a planner fills in by hand. The invariant that matters most: regenerating
 * afterwards must never destroy that manual work.
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

function assign(periodId: string, personId: string, slotId: string, bron: 'SOLVER' | 'MANUAL' | 'OVERRIDE') {
  db.prepare(
    `INSERT INTO dienstrooster_assignment
       (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`
  ).run(crypto.randomUUID(), periodId, personId, slotId, bron);
}

function blockSlot(personId: string, slotId: string, level: 'ABSOLUUT' | 'LIEVER_NIET') {
  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'MANUAL', datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId, level);
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
    db.prepare(
      `DELETE FROM dienstrooster_availability WHERE slot_id IN
       (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)`
    ).run(periodId);
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

describe('rosterGaps', () => {
  describe('findUnfilledSlots', () => {
    it('reports only slots short of their required headcount', () => {
      const f = createFixture(3, '2027-01-04', '2027-01-10'); // 7 slots
      assign(f.periodId, f.personIds[0], f.slotIds[0], 'SOLVER');
      assign(f.periodId, f.personIds[1], f.slotIds[1], 'MANUAL');

      const gaps = findUnfilledSlots(f.periodId);

      expect(gaps).toHaveLength(5);
      const gapIds = gaps.map((g) => g.slot_id);
      expect(gapIds).not.toContain(f.slotIds[0]);
      expect(gapIds).not.toContain(f.slotIds[1]);
    });

    it('never offers someone who hard-blocked that slot', () => {
      const f = createFixture(3, '2027-01-04', '2027-01-10');
      blockSlot(f.personIds[0], f.slotIds[0], 'ABSOLUUT');

      const gap = findUnfilledSlots(f.periodId).find((g) => g.slot_id === f.slotIds[0]);

      expect(gap).toBeDefined();
      expect(gap!.eligible_people.map((p) => p.id)).not.toContain(f.personIds[0]);
      expect(gap!.eligible_people).toHaveLength(2);
    });

    it('still offers someone who only marked the slot as prefer-not', () => {
      const f = createFixture(3, '2027-01-04', '2027-01-10');
      blockSlot(f.personIds[0], f.slotIds[0], 'LIEVER_NIET');

      const gap = findUnfilledSlots(f.periodId).find((g) => g.slot_id === f.slotIds[0]);

      expect(gap!.eligible_people.map((p) => p.id)).toContain(f.personIds[0]);
    });

    it('returns nothing once every slot is covered', () => {
      const f = createFixture(1, '2027-01-04', '2027-01-10');
      for (const slotId of f.slotIds) assign(f.periodId, f.personIds[0], slotId, 'SOLVER');

      expect(findUnfilledSlots(f.periodId)).toEqual([]);
    });
  });

  describe('regeneration safety', () => {
    it('treats manually filled slots as off-limits to the solver', () => {
      const f = createFixture(2, '2027-01-04', '2027-01-10');
      assign(f.periodId, f.personIds[0], f.slotIds[0], 'MANUAL');
      assign(f.periodId, f.personIds[1], f.slotIds[1], 'OVERRIDE');
      assign(f.periodId, f.personIds[0], f.slotIds[2], 'SOLVER');

      const reserved = getManuallyFilledSlotIds(f.periodId);

      expect(reserved.has(f.slotIds[0])).toBe(true);
      expect(reserved.has(f.slotIds[1])).toBe(true);
      expect(reserved.has(f.slotIds[2])).toBe(false);
    });

    it('clearing a previous solve leaves manual work untouched', () => {
      const f = createFixture(2, '2027-01-04', '2027-01-10');
      assign(f.periodId, f.personIds[0], f.slotIds[0], 'MANUAL');
      assign(f.periodId, f.personIds[1], f.slotIds[1], 'OVERRIDE');
      assign(f.periodId, f.personIds[0], f.slotIds[2], 'SOLVER');
      assign(f.periodId, f.personIds[1], f.slotIds[3], 'SOLVER');

      const deleted = clearSolverAssignments(f.periodId);

      expect(deleted).toBe(2);
      const remaining = db
        .prepare('SELECT slot_id, bron FROM dienstrooster_assignment WHERE schedule_version_id = ?')
        .all(f.periodId) as Array<{ slot_id: string; bron: string }>;

      expect(remaining).toHaveLength(2);
      expect(remaining.every((r) => r.bron !== 'SOLVER')).toBe(true);
      expect(remaining.map((r) => r.slot_id).sort()).toEqual([f.slotIds[0], f.slotIds[1]].sort());
    });

    it('a manually filled slot never collides with the unique (period, slot) index on regenerate', () => {
      // The real failure this guards: re-solving without excluding
      // manually filled slots would try to insert a second row for the
      // same (schedule_version_id, slot_id) and throw.
      const f = createFixture(2, '2027-01-04', '2027-01-10');
      assign(f.periodId, f.personIds[0], f.slotIds[0], 'MANUAL');

      clearSolverAssignments(f.periodId);
      const reserved = getManuallyFilledSlotIds(f.periodId);
      const solvableSlots = f.slotIds.filter((id) => !reserved.has(id));

      expect(() => {
        for (const slotId of solvableSlots) {
          assign(f.periodId, f.personIds[1], slotId, 'SOLVER');
        }
      }).not.toThrow();

      expect(solvableSlots).not.toContain(f.slotIds[0]);
    });
  });
});
