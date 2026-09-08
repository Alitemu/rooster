import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import {
  matchSlotsToAbsence,
  syncAvailabilityForAbsence,
  removeAbsenceAvailability,
  syncAvailabilityForPeriod,
} from '@/lib/absenceSync';

interface Fixture {
  poolId: string;
  personId: string;
  periodId: string;
}

function insertSlots(periodId: string, shiftTypeId: string, startDate: string, endDate: string) {
  const slots = generateSlotsForPeriod({
    startDate,
    endDate,
    shiftTypes: ['AVOND'],
  });
  const insertStmt = db.prepare(
    `INSERT INTO dienstrooster_shift_slot
       (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id,
        is_feestdag, feestdag_groep, benodigd_aantal_personen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  for (const slot of slots) {
    insertStmt.run(
      crypto.randomUUID(),
      periodId,
      shiftTypeId,
      slot.datum,
      slot.iso_jaar,
      slot.iso_week,
      slot.weekend_id || null,
      slot.is_feestdag ? 1 : 0,
      slot.feestdag_groep
    );
  }
  return slots;
}

function createFixture(startDate: string, endDate: string): Fixture {
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

  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`);

  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
  ).run(crypto.randomUUID(), personId, poolId);

  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'Test period', ?, ?, '2099-01-01T00:00:00Z', 'OPEN', datetime('now'))`
  ).run(periodId, poolId, startDate, endDate);

  insertSlots(periodId, shiftTypeId, startDate, endDate);

  return { poolId, personId, periodId };
}

function createAbsence(personId: string, vanDatum: string, totDatum: string, soort = 'VAKANTIE'): string {
  const absenceId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_absence
       (id, person_id, van_datum, tot_datum, soort, aangemaakt_door, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(absenceId, personId, vanDatum, totDatum, soort, personId);
  return absenceId;
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
    db.prepare(
      `DELETE FROM dienstrooster_absence WHERE person_id IN
       (SELECT person_id FROM dienstrooster_pool_membership WHERE pool_id = ?)`
    ).run(period.pool_id);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(period.pool_id);
    db.prepare('DELETE FROM dienstrooster_person WHERE id IN (SELECT person_id FROM dienstrooster_pool_membership WHERE pool_id = ?)').run(period.pool_id);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(period.pool_id) as { ruleset_id: string } | undefined;
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(period.pool_id);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(period.pool_id);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
});

describe('absenceSync', () => {
  describe('matchSlotsToAbsence', () => {
    it('matches only slots whose date falls within the absence range, inclusive of both ends', () => {
      const slots = [
        { id: 'before', datum: '2027-01-03' },
        { id: 'start', datum: '2027-01-04' },
        { id: 'middle', datum: '2027-01-06' },
        { id: 'end', datum: '2027-01-08' },
        { id: 'after', datum: '2027-01-09' },
      ];
      const matched = matchSlotsToAbsence({ van_datum: '2027-01-04', tot_datum: '2027-01-08' }, slots);
      expect(matched.sort()).toEqual(['end', 'middle', 'start']);
    });
  });

  describe('syncAvailabilityForAbsence', () => {
    it('a person marking themselves absent cannot end up assigned a shift on that day - it must generate an ABSOLUUT/ABSENCE row for every day covered', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      const absenceId = createAbsence(fixture.personId, '2027-01-05', '2027-01-07');

      const result = syncAvailabilityForAbsence(absenceId);
      expect(result.inserted).toBe(3);

      const rows = db
        .prepare(`SELECT blocking_level, source FROM dienstrooster_availability WHERE bron_absence_id = ?`)
        .all(absenceId) as Array<{ blocking_level: string; source: string }>;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.blocking_level).toBe('ABSOLUUT');
        expect(row.source).toBe('ABSENCE');
      }
    });

    it('never overwrites a MANUAL availability row', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      const slot = db
        .prepare(`SELECT id FROM dienstrooster_shift_slot WHERE period_id = ? AND datum = '2027-01-05'`)
        .get(fixture.periodId) as { id: string };

      db.prepare(
        `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
         VALUES (?, ?, ?, 'ABSOLUUT', 'MANUAL', datetime('now'))`
      ).run(crypto.randomUUID(), fixture.personId, slot.id);

      const absenceId = createAbsence(fixture.personId, '2027-01-05', '2027-01-05');
      const result = syncAvailabilityForAbsence(absenceId);

      expect(result.skippedManualConflicts).toBe(1);
      expect(result.inserted).toBe(0);

      const row = db
        .prepare('SELECT source, bron_absence_id FROM dienstrooster_availability WHERE slot_id = ?')
        .get(slot.id) as { source: string; bron_absence_id: string | null };
      expect(row.source).toBe('MANUAL');
      expect(row.bron_absence_id).toBeNull();
    });

    it('shortening an absence date range removes the now-out-of-range rows', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      const absenceId = createAbsence(fixture.personId, '2027-01-04', '2027-01-08');
      syncAvailabilityForAbsence(absenceId);

      db.prepare(`UPDATE dienstrooster_absence SET tot_datum = '2027-01-05' WHERE id = ?`).run(absenceId);
      const result = syncAvailabilityForAbsence(absenceId);

      expect(result.deleted).toBe(3); // 01-06, 01-07, 01-08 no longer covered
      expect(result.inserted).toBe(0);

      const remaining = db
        .prepare(
          `SELECT s.datum FROM dienstrooster_availability a
           JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
           WHERE a.bron_absence_id = ?`
        )
        .all(absenceId) as Array<{ datum: string }>;
      expect(remaining.map((r) => r.datum).sort()).toEqual(['2027-01-04', '2027-01-05']);
    });

    it('re-running sync with no change is a no-op', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      const absenceId = createAbsence(fixture.personId, '2027-01-04', '2027-01-06');

      syncAvailabilityForAbsence(absenceId);
      const second = syncAvailabilityForAbsence(absenceId);

      expect(second.inserted).toBe(0);
      expect(second.deleted).toBe(0);
    });

    it('only generates rows into OPEN periods, matching part-time patterns and the window rule', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'CONCEPT' WHERE id = ?`).run(fixture.periodId);

      const absenceId = createAbsence(fixture.personId, '2027-01-04', '2027-01-06');
      const result = syncAvailabilityForAbsence(absenceId);

      expect(result.inserted).toBe(0);
    });

    it('stops generating rows once the period deadline has passed, even while still OPEN', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      db.prepare(`UPDATE dienstrooster_schedule_period SET deadline = '2020-01-01T00:00:00Z' WHERE id = ?`).run(
        fixture.periodId
      );

      const absenceId = createAbsence(fixture.personId, '2027-01-04', '2027-01-06');
      const result = syncAvailabilityForAbsence(absenceId);

      expect(result.inserted).toBe(0);
    });
  });

  describe('removeAbsenceAvailability', () => {
    it('deletes every row generated by the absence and leaves nothing orphaned, without throwing', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      const absenceId = createAbsence(fixture.personId, '2027-01-04', '2027-01-06');
      syncAvailabilityForAbsence(absenceId);

      expect(() => {
        removeAbsenceAvailability(absenceId);
        db.prepare('DELETE FROM dienstrooster_absence WHERE id = ?').run(absenceId);
      }).not.toThrow();

      const remaining = db
        .prepare('SELECT COUNT(*) as count FROM dienstrooster_availability WHERE bron_absence_id = ?')
        .get(absenceId) as { count: number };
      expect(remaining.count).toBe(0);
    });
  });

  describe('syncAvailabilityForPeriod', () => {
    it('backfills an absence registered before the period had any slots', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      const absenceId = createAbsence(fixture.personId, '2027-01-05', '2027-01-05');

      // Simulate the absence predating slot generation: clear what a real
      // create-then-sync flow would have already inserted, then backfill.
      db.prepare('DELETE FROM dienstrooster_availability WHERE bron_absence_id = ?').run(absenceId);

      const result = syncAvailabilityForPeriod(fixture.periodId);
      expect(result.inserted).toBe(1);
      expect(result.absencesProcessed).toBe(1);
    });

    it('does nothing for a period that is not OPEN', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'CONCEPT' WHERE id = ?`).run(fixture.periodId);
      createAbsence(fixture.personId, '2027-01-05', '2027-01-05');

      const result = syncAvailabilityForPeriod(fixture.periodId);
      expect(result.inserted).toBe(0);
      expect(result.absencesProcessed).toBe(0);
    });

    it('skips absences belonging to an inactive (actief=0) person', () => {
      // Same "who belongs to this period" convention as
      // capacity/generate-roster/exports (see lib/carryOver.ts,
      // lib/rosterGaps.ts, lib/publicationCheck.ts) - a person who left
      // the ward but still has an overlapping pool_membership row must
      // not keep generating ABSENCE rows on every backfill.
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      const absenceId = createAbsence(fixture.personId, '2027-01-05', '2027-01-05');
      db.prepare('DELETE FROM dienstrooster_availability WHERE bron_absence_id = ?').run(absenceId);
      db.prepare('UPDATE dienstrooster_person SET actief = 0 WHERE id = ?').run(fixture.personId);

      const result = syncAvailabilityForPeriod(fixture.periodId);
      expect(result.inserted).toBe(0);
      expect(result.absencesProcessed).toBe(0);
    });
  });
});
