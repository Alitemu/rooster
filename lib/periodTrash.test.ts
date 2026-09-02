import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import {
  softDeletePeriod,
  restorePeriod,
  purgePeriodNow,
  purgeExpiredPeriods,
  listTrash,
  PeriodTrashError,
  RETENTION_DAYS,
} from '@/lib/periodTrash';

interface Fixture {
  poolId: string;
  personId: string;
  periodId: string;
  slotId: string;
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * One full period with a slot and one dependent row in every table that
 * cascadeDeletePeriod() has to clean up, so a purge test can prove nothing
 * is left behind rather than just that the period row itself is gone.
 */
function createFixture(status = 'OPEN'): Fixture {
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
     VALUES (?, ?, 'Test period', '2027-01-04', '2027-01-10', '2026-12-15T17:00:00Z', ?, datetime('now'))`
  ).run(periodId, poolId, status);

  const slotId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot
       (id, period_id, shift_type_id, datum, iso_jaar, iso_week, is_feestdag, benodigd_aantal_personen)
     VALUES (?, ?, ?, '2027-01-04', 2027, 1, 0, 1)`
  ).run(slotId, periodId, shiftTypeId);

  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
     VALUES (?, ?, ?, 'ABSOLUUT', 'MANUAL', datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId);

  db.prepare(
    `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'SOLVER', datetime('now'))`
  ).run(crypto.randomUUID(), periodId, personId, slotId);

  db.prepare(
    `INSERT INTO dienstrooster_submission (id, person_id, schedule_period_id, status, aangemaakt_op)
     VALUES (?, ?, ?, 'BEZIG', datetime('now'))`
  ).run(crypto.randomUUID(), personId, periodId);

  db.prepare(
    `INSERT INTO dienstrooster_ledger_entry
       (id, person_id, pool_id, teller, geldt_voor_periode_id, delta, reden, categorie, aangemaakt_door, aangemaakt_op)
     VALUES (?, ?, ?, 'AVOND', ?, -1, 'test', 'BEGINSALDO', ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, poolId, periodId, personId);

  db.prepare(
    `INSERT INTO dienstrooster_period_excluded_day (id, period_id, datum, reden)
     VALUES (?, ?, '2027-01-04', 'test')`
  ).run(crypto.randomUUID(), periodId);

  db.prepare(
    `INSERT INTO dienstrooster_prior_assignment
       (id, period_id, datum, iso_jaar, iso_week, person_id, teller, bron, aangemaakt_door, aangemaakt_op)
     VALUES (?, ?, '2027-01-04', 2027, 1, ?, 'AVOND', 'HANDMATIG', ?, datetime('now'))`
  ).run(crypto.randomUUID(), periodId, personId, personId);

  db.prepare(
    `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, geldt_voor_periode_id, aangemaakt_op)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, crypto.randomUUID(), periodId);

  return { poolId, personId, periodId, slotId };
}

const createdPoolIds: string[] = [];
const createdPersonIds: string[] = [];

function trackFixture(f: Fixture): Fixture {
  createdPoolIds.push(f.poolId);
  createdPersonIds.push(f.personId);
  return f;
}

afterEach(() => {
  // Best-effort teardown: the function under test has often already
  // deleted the period (and everything scoped to it) by the time a test
  // finishes, so this only needs to clean up what a purge wouldn't have
  // touched (pool/person/ruleset), and tolerate rows that are already gone.
  while (createdPoolIds.length > 0) {
    const poolId = createdPoolIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE entiteit = ?').run('schedule_period');
    db.prepare(
      `DELETE FROM dienstrooster_availability WHERE slot_id IN
       (SELECT id FROM dienstrooster_shift_slot WHERE period_id IN
        (SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?))`
    ).run(poolId);
    db.prepare(
      `DELETE FROM dienstrooster_assignment WHERE slot_id IN
       (SELECT id FROM dienstrooster_shift_slot WHERE period_id IN
        (SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?))`
    ).run(poolId);
    db.prepare(
      `DELETE FROM dienstrooster_shift_slot WHERE period_id IN
       (SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?)`
    ).run(poolId);
    db.prepare(
      `DELETE FROM dienstrooster_submission WHERE schedule_period_id IN
       (SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?)`
    ).run(poolId);
    db.prepare(
      `DELETE FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id IN
       (SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?)`
    ).run(poolId);
    db.prepare(
      `DELETE FROM dienstrooster_period_excluded_day WHERE period_id IN
       (SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?)`
    ).run(poolId);
    db.prepare(
      `DELETE FROM dienstrooster_prior_assignment WHERE period_id IN
       (SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?)`
    ).run(poolId);
    db.prepare(
      `DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id IN
       (SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?)`
    ).run(poolId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE pool_id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as
      | { ruleset_id: string }
      | undefined;
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  while (createdPersonIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(createdPersonIds.pop()!);
  }
});

describe('periodTrash', () => {
  describe('softDeletePeriod / restorePeriod', () => {
    it('a soft-deleted period appears in the trash and disappears once restored', () => {
      const f = trackFixture(createFixture());

      softDeletePeriod(f.periodId, f.personId);
      expect(listTrash().map((p) => p.id)).toContain(f.periodId);

      restorePeriod(f.periodId, f.personId);
      expect(listTrash().map((p) => p.id)).not.toContain(f.periodId);
    });

    it('cannot soft-delete a period that is already in the trash', () => {
      const f = trackFixture(createFixture());
      softDeletePeriod(f.periodId, f.personId);

      expect(() => softDeletePeriod(f.periodId, f.personId)).toThrow(PeriodTrashError);
    });

    it('cannot restore a period that was never deleted', () => {
      const f = trackFixture(createFixture());
      expect(() => restorePeriod(f.periodId, f.personId)).toThrow(PeriodTrashError);
    });
  });

  // ---------------------------------------------------------------------
  // HARD RULE: permanent deletion always goes through the trash first
  // ---------------------------------------------------------------------
  describe('purgePeriodNow', () => {
    it('refuses to permanently delete a period that is not in the trash', () => {
      const f = trackFixture(createFixture());

      expect(() => purgePeriodNow(f.periodId, f.personId)).toThrow(PeriodTrashError);

      // Proves it: the period (and its slot) must still exist.
      const period = db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE id = ?').get(f.periodId);
      expect(period).toBeDefined();
    });

    it('removes every dependent row, leaving no orphans, once the period is in the trash', () => {
      const f = trackFixture(createFixture());
      softDeletePeriod(f.periodId, f.personId);

      purgePeriodNow(f.periodId, f.personId);

      expect(db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE id = ?').get(f.periodId)).toBeUndefined();
      expect(db.prepare('SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?').get(f.periodId)).toBeUndefined();
      expect(db.prepare('SELECT id FROM dienstrooster_availability WHERE slot_id = ?').get(f.slotId)).toBeUndefined();
      expect(db.prepare('SELECT id FROM dienstrooster_assignment WHERE slot_id = ?').get(f.slotId)).toBeUndefined();
      expect(
        db.prepare('SELECT id FROM dienstrooster_submission WHERE schedule_period_id = ?').get(f.periodId)
      ).toBeUndefined();
      expect(
        db.prepare('SELECT id FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ?').get(f.periodId)
      ).toBeUndefined();
      expect(
        db.prepare('SELECT id FROM dienstrooster_period_excluded_day WHERE period_id = ?').get(f.periodId)
      ).toBeUndefined();
      expect(
        db.prepare('SELECT id FROM dienstrooster_prior_assignment WHERE period_id = ?').get(f.periodId)
      ).toBeUndefined();
      expect(
        db.prepare('SELECT id FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').get(f.periodId)
      ).toBeUndefined();

      // The person itself (not period-scoped) must survive the purge.
      expect(db.prepare('SELECT id FROM dienstrooster_person WHERE id = ?').get(f.personId)).toBeDefined();
    });

    it("nulls another period's bron_period_id instead of deleting that period's own row", () => {
      const source = trackFixture(createFixture());
      const derived = trackFixture(createFixture());

      // derived's prior_assignment row cites `source` as where it came
      // from - a real cross-period reference, distinct from derived's own
      // period_id (its actual owner, untouched by this purge).
      db.prepare('UPDATE dienstrooster_prior_assignment SET bron_period_id = ? WHERE period_id = ?').run(
        source.periodId,
        derived.periodId
      );
      db.prepare('UPDATE dienstrooster_period_excluded_day SET bron_period_id = ? WHERE period_id = ?').run(
        source.periodId,
        derived.periodId
      );

      softDeletePeriod(source.periodId, source.personId);
      purgePeriodNow(source.periodId, source.personId);

      const priorAssignment = db
        .prepare('SELECT bron_period_id FROM dienstrooster_prior_assignment WHERE period_id = ?')
        .get(derived.periodId) as { bron_period_id: string | null } | undefined;
      const excludedDay = db
        .prepare('SELECT bron_period_id FROM dienstrooster_period_excluded_day WHERE period_id = ?')
        .get(derived.periodId) as { bron_period_id: string | null } | undefined;

      expect(priorAssignment).toBeDefined();
      expect(priorAssignment!.bron_period_id).toBeNull();
      expect(excludedDay).toBeDefined();
      expect(excludedDay!.bron_period_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // HARD RULE: the retention window - never purge early, never keep forever
  // ---------------------------------------------------------------------
  describe('purgeExpiredPeriods', () => {
    it(`leaves a period deleted ${RETENTION_DAYS - 1} days ago untouched`, () => {
      const f = trackFixture(createFixture());
      softDeletePeriod(f.periodId, f.personId);
      db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?').run(
        daysAgoISO(RETENTION_DAYS - 1),
        f.periodId
      );

      const result = purgeExpiredPeriods(f.personId);

      expect(result.purged).toBe(0);
      expect(db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE id = ?').get(f.periodId)).toBeDefined();
    });

    it(`purges a period deleted more than ${RETENTION_DAYS} days ago`, () => {
      const f = trackFixture(createFixture());
      softDeletePeriod(f.periodId, f.personId);
      db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?').run(
        daysAgoISO(RETENTION_DAYS + 1),
        f.periodId
      );

      const result = purgeExpiredPeriods(f.personId);

      expect(result.purged).toBe(1);
      expect(db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE id = ?').get(f.periodId)).toBeUndefined();
    });

    it('never touches a period that was never deleted', () => {
      const f = trackFixture(createFixture());

      const result = purgeExpiredPeriods(f.personId);

      expect(result.purged).toBe(0);
      expect(db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE id = ?').get(f.periodId)).toBeDefined();
    });
  });
});
