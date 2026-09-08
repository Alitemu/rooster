import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import { writePreferencesBackup, BACKUP_DIR } from '@/lib/preferencesBackup';

interface Fixture {
  poolId: string;
  personId: string;
  periodId: string;
  codenaam: string;
  periodNaam: string;
  slotIds: Record<string, string>; // datum -> slot id
}

function createFixture(overrides?: { personId?: string; codenaam?: string; periodNaam?: string }): Fixture {
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

  const personId = overrides?.personId ?? crypto.randomUUID();
  const codenaam = overrides?.codenaam ?? `Test-${personId.slice(0, 8)}`;
  if (!overrides?.personId) {
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', datetime('now'))`
    ).run(personId, codenaam);
  }

  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
  ).run(crypto.randomUUID(), personId, poolId);

  const periodId = crypto.randomUUID();
  const periodNaam = overrides?.periodNaam ?? `Backup-test-${periodId.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, ?, '2027-01-04', '2027-01-10', '2099-01-01T00:00:00Z', 'OPEN', datetime('now'))`
  ).run(periodId, poolId, periodNaam);

  const slots = generateSlotsForPeriod({
    startDate: '2027-01-04',
    endDate: '2027-01-10',
    shiftTypes: ['AVOND'],
  });
  const insertSlotStmt = db.prepare(
    `INSERT INTO dienstrooster_shift_slot
       (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id,
        is_feestdag, feestdag_groep, benodigd_aantal_personen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  const slotIds: Record<string, string> = {};
  for (const slot of slots) {
    const slotId = crypto.randomUUID();
    slotIds[slot.datum] = slotId;
    insertSlotStmt.run(
      slotId,
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

  return { poolId, personId, periodId, codenaam, periodNaam, slotIds };
}

const createdPeriodIds: string[] = [];
const writtenFiles: string[] = [];

function trackFixture(f: Fixture): Fixture {
  createdPeriodIds.push(f.periodId);
  return f;
}

afterEach(() => {
  for (const filePath of writtenFiles.splice(0)) {
    fs.rmSync(filePath, { force: true });
  }

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
    // Must select the members before deleting the membership rows below -
    // the old order deleted pool_membership first, so this SELECT always
    // came back empty and no person row was ever actually removed,
    // leaking a person per test run.
    const members = db
      .prepare('SELECT person_id FROM dienstrooster_pool_membership WHERE pool_id = ?')
      .all(period.pool_id) as Array<{ person_id: string }>;
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(period.pool_id);
    for (const m of members) {
      // A person shared across two fixtures (see the same-name collision
      // test below) can still have a membership row in the *other*
      // fixture's pool at this point - deleting them now would violate
      // that row's foreign key. Only delete once nothing references them.
      const stillReferenced = db
        .prepare('SELECT 1 FROM dienstrooster_pool_membership WHERE person_id = ?')
        .get(m.person_id);
      if (!stillReferenced) {
        db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(m.person_id);
      }
    }
    const pool = db
      .prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?')
      .get(period.pool_id) as { ruleset_id: string } | undefined;
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(period.pool_id);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(period.pool_id);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
});

function setBlockingLevel(personId: string, slotId: string, level: string) {
  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'MANUAL', datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId, level);
}

describe('writePreferencesBackup', () => {
  it('writes a CSV containing only the slots with a set preference', () => {
    const fixture = trackFixture(createFixture());
    setBlockingLevel(fixture.personId, fixture.slotIds['2027-01-04'], 'ABSOLUUT');
    setBlockingLevel(fixture.personId, fixture.slotIds['2027-01-08'], 'VOORKEUR');

    const filePath = writePreferencesBackup(fixture.personId, fixture.periodId)!;
    writtenFiles.push(filePath);

    expect(fs.existsSync(filePath)).toBe(true);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines[0]).toBe('codenaam,periode,datum,iso_week,teller,voorkeur,bron,opgeslagen_op');
    expect(lines).toHaveLength(3); // header + 2 set preferences
    expect(lines[1]).toContain('2027-01-04');
    expect(lines[1]).toContain('ABSOLUUT');
    expect(lines[2]).toContain('2027-01-08');
    expect(lines[2]).toContain('VOORKEUR');
  });

  it('replaces the previous backup file instead of leaving it alongside the new one', () => {
    const fixture = trackFixture(createFixture());
    setBlockingLevel(fixture.personId, fixture.slotIds['2027-01-04'], 'ABSOLUUT');

    const firstPath = writePreferencesBackup(fixture.personId, fixture.periodId)!;
    writtenFiles.push(firstPath);
    const firstContent = fs.readFileSync(firstPath, 'utf-8');

    setBlockingLevel(fixture.personId, fixture.slotIds['2027-01-05'], 'LIEVER_NIET');
    const secondPath = writePreferencesBackup(fixture.personId, fixture.periodId)!;
    writtenFiles.push(secondPath);

    // A rapid second save can land on the same filesystem-second as the
    // first (millisecond timestamps make this rare, not impossible) - what
    // must always hold is the invariant, not that the two paths differ.
    expect(fs.existsSync(secondPath)).toBe(true);
    expect(fs.readFileSync(secondPath, 'utf-8')).not.toBe(firstContent);
    if (firstPath !== secondPath) {
      expect(fs.existsSync(firstPath)).toBe(false);
    }

    const prefix = `${fixture.codenaam}__${fixture.periodId}__`;
    const matching = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith(prefix));
    expect(matching).toHaveLength(1);
  });

  it('does not let two periods with the same name overwrite each other\'s backup', () => {
    // The dedup prefix used to be built from the (non-unique) period
    // *name* - two periods sharing a name would then share a prefix, and
    // saving one's backup would delete the other's file via the
    // startsWith-prefix cleanup loop. It must be built from period.id
    // instead, which is always unique.
    const fixtureA = trackFixture(createFixture());
    // Same person (the collision only happens when the codenaam half of
    // the prefix also matches) and deliberately the same period name.
    const fixtureB = trackFixture(
      createFixture({ personId: fixtureA.personId, codenaam: fixtureA.codenaam, periodNaam: fixtureA.periodNaam })
    );
    expect(fixtureB.periodNaam).toBe(fixtureA.periodNaam);
    expect(fixtureB.periodId).not.toBe(fixtureA.periodId);

    setBlockingLevel(fixtureA.personId, fixtureA.slotIds['2027-01-04'], 'ABSOLUUT');
    setBlockingLevel(fixtureB.personId, fixtureB.slotIds['2027-01-04'], 'LIEVER_NIET');

    const pathA = writePreferencesBackup(fixtureA.personId, fixtureA.periodId)!;
    writtenFiles.push(pathA);
    const pathB = writePreferencesBackup(fixtureB.personId, fixtureB.periodId)!;
    writtenFiles.push(pathB);

    expect(fs.existsSync(pathA)).toBe(true);
    expect(fs.existsSync(pathB)).toBe(true);
    expect(fs.readFileSync(pathA, 'utf-8')).toContain('ABSOLUUT');
    expect(fs.readFileSync(pathB, 'utf-8')).toContain('LIEVER_NIET');
  });

  it('still writes an (empty) file for a person with nothing set yet', () => {
    const fixture = trackFixture(createFixture());
    const filePath = writePreferencesBackup(fixture.personId, fixture.periodId)!;
    writtenFiles.push(filePath);

    expect(fs.existsSync(filePath)).toBe(true);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1); // header only
  });

  it('returns null for an unknown person or period instead of throwing', () => {
    expect(writePreferencesBackup('does-not-exist', 'also-does-not-exist')).toBeNull();
  });
});
