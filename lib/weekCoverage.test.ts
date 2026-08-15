import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import { getWeekCoverageStatus, computeCoverageByWeek } from '@/lib/weekCoverage';

interface Fixture {
  poolId: string;
  personIds: string[];
  periodId: string;
}

function insertSlots(periodId: string, shiftTypeId: string, startDate: string, endDate: string) {
  const slots = generateSlotsForPeriod({ startDate, endDate, shiftTypes: ['AVOND'] });
  const insertStmt = db.prepare(
    `INSERT INTO dienstrooster_shift_slot
       (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id,
        is_feestdag, feestdag_groep, benodigd_aantal_personen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  const inserted: Array<{ id: string; datum: string; iso_week: number }> = [];
  for (const slot of slots) {
    const id = crypto.randomUUID();
    insertStmt.run(
      id,
      periodId,
      shiftTypeId,
      slot.datum,
      slot.iso_jaar,
      slot.iso_week,
      slot.weekend_id || null,
      slot.is_feestdag ? 1 : 0,
      slot.feestdag_groep
    );
    inserted.push({ id, datum: slot.datum, iso_week: slot.iso_week });
  }
  return inserted;
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
     VALUES (?, ?, 'Test period', ?, ?, '2099-01-01T00:00:00Z', 'OPEN', datetime('now'))`
  ).run(periodId, poolId, startDate, endDate);

  insertSlots(periodId, shiftTypeId, startDate, endDate);

  return { poolId, personIds, periodId };
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
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(period.pool_id) as { ruleset_id: string } | undefined;
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(period.pool_id);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(period.pool_id);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
});

describe('weekCoverage', () => {
  describe('getWeekCoverageStatus', () => {
    it('is red at and below 7, orange from 8-10, green at and above 11', () => {
      expect(getWeekCoverageStatus(0)).toBe('red');
      expect(getWeekCoverageStatus(7)).toBe('red');
      expect(getWeekCoverageStatus(8)).toBe('orange');
      expect(getWeekCoverageStatus(10)).toBe('orange');
      expect(getWeekCoverageStatus(11)).toBe('green');
      expect(getWeekCoverageStatus(30)).toBe('green');
    });
  });

  describe('computeCoverageByWeek', () => {
    it('a person blocking 6 of 7 slots in a week still counts as available for that week', () => {
      const fixture = trackFixture(createFixture(12, '2027-01-04', '2027-01-10'));
      const slots = db
        .prepare('SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?')
        .all(fixture.periodId) as Array<{ id: string }>;
      expect(slots).toHaveLength(7);

      for (const slot of slots.slice(0, 6)) {
        blockSlot(fixture.personIds[0], slot.id, 'ABSOLUUT');
      }

      const weeks = computeCoverageByWeek(fixture.periodId, fixture.poolId);
      expect(weeks).toHaveLength(1);
      expect(weeks[0].available_count).toBe(12);
    });

    it('a person blocking every slot in a week is excluded from that week only', () => {
      const fixture = trackFixture(createFixture(12, '2027-01-04', '2027-01-17'));
      const week1Slots = db
        .prepare(
          `SELECT id FROM dienstrooster_shift_slot WHERE period_id = ? AND datum BETWEEN '2027-01-04' AND '2027-01-10'`
        )
        .all(fixture.periodId) as Array<{ id: string }>;
      expect(week1Slots).toHaveLength(7);

      for (const slot of week1Slots) {
        blockSlot(fixture.personIds[0], slot.id, 'ABSOLUUT');
      }

      const weeks = computeCoverageByWeek(fixture.periodId, fixture.poolId);
      expect(weeks).toHaveLength(2);
      expect(weeks[0].available_count).toBe(11);
      expect(weeks[1].available_count).toBe(12);
    });

    it('LIEVER_NIET never reduces available_count, even on every slot in the week', () => {
      const fixture = trackFixture(createFixture(12, '2027-01-04', '2027-01-10'));
      const slots = db
        .prepare('SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?')
        .all(fixture.periodId) as Array<{ id: string }>;

      for (const slot of slots) {
        blockSlot(fixture.personIds[0], slot.id, 'LIEVER_NIET');
      }

      const weeks = computeCoverageByWeek(fixture.periodId, fixture.poolId);
      expect(weeks[0].available_count).toBe(12);
    });

    it('excludes people who are no longer pool members from both pool_size and available_count', () => {
      const fixture = trackFixture(createFixture(12, '2027-01-04', '2027-01-10'));
      // Make one membership expire before the period starts
      db.prepare(
        `UPDATE dienstrooster_pool_membership SET geldig_tot = '2026-01-01' WHERE person_id = ?`
      ).run(fixture.personIds[0]);

      const weeks = computeCoverageByWeek(fixture.periodId, fixture.poolId);
      expect(weeks[0].pool_size).toBe(11);
      expect(weeks[0].available_count).toBe(11);
    });

    it('assigns the correct status alongside the count', () => {
      // Pool of 7: everyone available -> exactly at the red/orange boundary
      const fixture = trackFixture(createFixture(7, '2027-01-04', '2027-01-10'));
      const weeks = computeCoverageByWeek(fixture.periodId, fixture.poolId);
      expect(weeks[0].available_count).toBe(7);
      expect(weeks[0].status).toBe('red');
    });
  });
});
