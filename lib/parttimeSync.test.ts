import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import {
  matchSlotsToPattern,
  isYearBoundaryWeek,
  previewPatternDates,
  syncAvailabilityForPattern,
  removePatternAvailability,
  type PatternRule,
} from '@/lib/parttimeSync';

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

function createPattern(
  personId: string,
  weekdag: string,
  frequentie: string,
  geldig_vanaf: string,
  geldig_tot: string
): string {
  const patternId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_parttime_pattern
       (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(patternId, personId, weekdag, frequentie, geldig_vanaf, geldig_tot, personId);
  return patternId;
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
      `DELETE FROM dienstrooster_parttime_pattern WHERE person_id IN
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

describe('parttimeSync', () => {
  describe('matchSlotsToPattern', () => {
    it('a MA pattern only ever matches Monday slots', () => {
      const slots = [
        { id: 'mon', datum: '2027-01-04', iso_week: 1 },
        { id: 'tue', datum: '2027-01-05', iso_week: 1 },
        { id: 'wed', datum: '2027-01-06', iso_week: 1 },
      ];
      const matched = matchSlotsToPattern(
        { weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2027-01-01', geldig_tot: '2027-12-31' },
        slots
      );
      expect(matched).toEqual(['mon']);
    });

    it('even/odd week matching uses the real persisted ISO week, not a Jan-1-relative approximation', () => {
      // 2026 is a 53-week year (Jan 1, 2026 is a Thursday) - straddle the
      // 2026 W53 -> 2027 W01 boundary, where a naive day-count formula and
      // the real ISO week number disagree.
      const slots = generateSlotsForPeriod({
        startDate: '2026-12-21',
        endDate: '2027-01-10',
        shiftTypes: ['AVOND'],
      }).map((s) => ({ id: s.datum, datum: s.datum, iso_week: s.iso_week }));

      const wednesdaySlots = slots.filter((s) => new Date(s.datum).getUTCDay() === 3);
      expect(wednesdaySlots.length).toBeGreaterThanOrEqual(2);

      const matched = matchSlotsToPattern(
        { weekdag: 'WO', frequentie: 'EVEN_WEKEN', geldig_vanaf: '2026-01-01', geldig_tot: '2027-12-31' },
        slots
      );

      for (const slotId of matched) {
        const slot = slots.find((s) => s.id === slotId)!;
        expect(slot.iso_week % 2).toBe(0);
      }
      // At least one matched slot should be a real even ISO week
      expect(matched.length).toBeGreaterThan(0);
    });

    it('excludes dates outside the pattern validity range', () => {
      const slots = [{ id: 'mon', datum: '2027-01-04', iso_week: 1 }];
      const matched = matchSlotsToPattern(
        { weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2027-02-01', geldig_tot: '2027-12-31' },
        slots
      );
      expect(matched).toEqual([]);
    });
  });

  describe('previewPatternDates', () => {
    it('agrees exactly with matchSlotsToPattern for the same range - a preview before a period opens can never show different days than what actually gets blocked once it does', () => {
      const pattern: PatternRule = { weekdag: 'WO', frequentie: 'EVEN_WEKEN', geldig_vanaf: '2026-01-01', geldig_tot: '2027-12-31' };
      const slots = generateSlotsForPeriod({
        startDate: '2026-12-21',
        endDate: '2027-01-10',
        shiftTypes: ['AVOND'],
      }).map((s) => ({ id: s.datum, datum: s.datum, iso_week: s.iso_week }));

      const matchedDates = matchSlotsToPattern(pattern, slots).sort();
      const previewedDates = previewPatternDates(pattern, '2026-12-21', '2027-01-10')
        .map((d) => d.datum)
        .sort();

      expect(previewedDates).toEqual(matchedDates);
    });

    it('excludes dates outside the pattern validity range even when the requested range is wider', () => {
      const previewed = previewPatternDates(
        { weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2027-02-01', geldig_tot: '2027-02-28' },
        '2027-01-01',
        '2027-03-31'
      );
      expect(previewed.every((d) => d.datum >= '2027-02-01' && d.datum <= '2027-02-28')).toBe(true);
      expect(previewed.some((d) => d.datum === '2027-02-01')).toBe(true);
      expect(previewed.some((d) => d.datum.startsWith('2027-01'))).toBe(false);
      expect(previewed.some((d) => d.datum.startsWith('2027-03'))).toBe(false);
    });

    it('returns nothing when the pattern and the requested range never overlap', () => {
      const previewed = previewPatternDates(
        { weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2027-01-01', geldig_tot: '2027-01-31' },
        '2027-03-01',
        '2027-03-31'
      );
      expect(previewed).toEqual([]);
    });
  });

  describe('isYearBoundaryWeek', () => {
    it('is true only for ISO week 1, 52, or 53', () => {
      expect(isYearBoundaryWeek(1)).toBe(true);
      expect(isYearBoundaryWeek(52)).toBe(true);
      expect(isYearBoundaryWeek(53)).toBe(true);
      expect(isYearBoundaryWeek(2)).toBe(false);
      expect(isYearBoundaryWeek(26)).toBe(false);
    });
  });

  describe('syncAvailabilityForPattern', () => {
    it('generates ABSOLUUT/PARTTIME rows for every matching slot', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      const patternId = createPattern(fixture.personId, 'MA', 'ELKE_WEEK', '2027-01-01', '2027-12-31');

      const result = syncAvailabilityForPattern(patternId);
      expect(result.inserted).toBe(1);

      const rows = db
        .prepare(
          `SELECT blocking_level, source FROM dienstrooster_availability WHERE bron_pattern_id = ?`
        )
        .all(patternId) as Array<{ blocking_level: string; source: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].blocking_level).toBe('ABSOLUUT');
      expect(rows[0].source).toBe('PARTTIME');
    });

    it('never overwrites a MANUAL availability row', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      const mondaySlot = db
        .prepare(
          `SELECT id FROM dienstrooster_shift_slot WHERE period_id = ? AND datum = '2027-01-04'`
        )
        .get(fixture.periodId) as { id: string };

      db.prepare(
        `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
         VALUES (?, ?, ?, 'ABSOLUUT', 'MANUAL', datetime('now'))`
      ).run(crypto.randomUUID(), fixture.personId, mondaySlot.id);

      const patternId = createPattern(fixture.personId, 'MA', 'ELKE_WEEK', '2027-01-01', '2027-12-31');
      const result = syncAvailabilityForPattern(patternId);

      expect(result.skippedManualConflicts).toBe(1);
      expect(result.inserted).toBe(0);

      const row = db
        .prepare('SELECT source, bron_pattern_id FROM dienstrooster_availability WHERE slot_id = ?')
        .get(mondaySlot.id) as { source: string; bron_pattern_id: string | null };
      expect(row.source).toBe('MANUAL');
      expect(row.bron_pattern_id).toBeNull();
    });

    it('re-running sync with no pattern change is a no-op', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      const patternId = createPattern(fixture.personId, 'MA', 'ELKE_WEEK', '2027-01-01', '2027-12-31');

      syncAvailabilityForPattern(patternId);
      const second = syncAvailabilityForPattern(patternId);

      expect(second.inserted).toBe(0);
      expect(second.deleted).toBe(0);
    });

    it('changing a pattern weekday removes old-day rows and adds new-day rows', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      const patternId = createPattern(fixture.personId, 'MA', 'ELKE_WEEK', '2027-01-01', '2027-12-31');
      syncAvailabilityForPattern(patternId);

      db.prepare(`UPDATE dienstrooster_parttime_pattern SET weekdag = 'DI' WHERE id = ?`).run(patternId);
      const result = syncAvailabilityForPattern(patternId);

      expect(result.inserted).toBe(1);
      expect(result.deleted).toBe(1);

      const rows = db
        .prepare(
          `SELECT s.datum FROM dienstrooster_availability a
           JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
           WHERE a.bron_pattern_id = ?`
        )
        .all(patternId) as Array<{ datum: string }>;
      expect(rows).toEqual([{ datum: '2027-01-05' }]);
    });

    it('only generates rows into OPEN periods', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'CONCEPT' WHERE id = ?`).run(fixture.periodId);

      const patternId = createPattern(fixture.personId, 'MA', 'ELKE_WEEK', '2027-01-01', '2027-12-31');
      const result = syncAvailabilityForPattern(patternId);

      expect(result.inserted).toBe(0);
    });
  });

  describe('removePatternAvailability', () => {
    it('deletes every row generated by the pattern and leaves nothing orphaned, without throwing', () => {
      const fixture = trackFixture(createFixture('2027-01-04', '2027-01-10'));
      const patternId = createPattern(fixture.personId, 'MA', 'ELKE_WEEK', '2027-01-01', '2027-12-31');
      syncAvailabilityForPattern(patternId);

      expect(() => {
        removePatternAvailability(patternId);
        db.prepare('DELETE FROM dienstrooster_parttime_pattern WHERE id = ?').run(patternId);
      }).not.toThrow();

      const remaining = db
        .prepare('SELECT COUNT(*) as count FROM dienstrooster_availability WHERE bron_pattern_id = ?')
        .get(patternId) as { count: number };
      expect(remaining.count).toBe(0);
    });
  });
});
