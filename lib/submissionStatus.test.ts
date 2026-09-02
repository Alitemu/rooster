import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { markSubmissionStarted } from '@/lib/submissionStatus';

interface Fixture {
  poolId: string;
  personId: string;
  periodId: string;
}

function createFixture(): Fixture {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Test ruleset', '{}');

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Test pool', rulesetId);

  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`);

  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'Test period', '2027-01-04', '2027-01-10', '2026-12-15T17:00:00Z', 'OPEN', datetime('now'))`
  ).run(periodId, poolId);

  return { poolId, personId, periodId };
}

const createdPersonIds: string[] = [];
const createdPoolIds: string[] = [];

afterEach(() => {
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_submission WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
  while (createdPoolIds.length > 0) {
    const poolId = createdPoolIds.pop()!;
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as
      | { ruleset_id: string }
      | undefined;
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE pool_id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
});

function track(f: Fixture): Fixture {
  createdPersonIds.push(f.personId);
  createdPoolIds.push(f.poolId);
  return f;
}

describe('markSubmissionStarted', () => {
  it('creates a BEZIG row when a person has no submission row yet', () => {
    const f = track(createFixture());

    markSubmissionStarted(f.personId, f.periodId);

    const row = db
      .prepare('SELECT status FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?')
      .get(f.personId, f.periodId) as { status: string } | undefined;

    expect(row?.status).toBe('BEZIG');
  });

  it('promotes an explicit NIET_BEGONNEN row to BEZIG', () => {
    const f = track(createFixture());
    db.prepare(
      `INSERT INTO dienstrooster_submission (id, person_id, schedule_period_id, status, row_version, aangemaakt_op)
       VALUES (?, ?, ?, 'NIET_BEGONNEN', 1, datetime('now'))`
    ).run(crypto.randomUUID(), f.personId, f.periodId);

    markSubmissionStarted(f.personId, f.periodId);

    const row = db
      .prepare('SELECT status FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?')
      .get(f.personId, f.periodId) as { status: string };

    expect(row.status).toBe('BEZIG');
  });

  // HARD RULE: a routine edit must never silently un-confirm someone who
  // already submitted - only the explicit submit action changes that.
  it('never downgrades an already-confirmed (BEVESTIGD) submission', () => {
    const f = track(createFixture());
    db.prepare(
      `INSERT INTO dienstrooster_submission (id, person_id, schedule_period_id, status, row_version, aangemaakt_op)
       VALUES (?, ?, ?, 'BEVESTIGD', 1, datetime('now'))`
    ).run(crypto.randomUUID(), f.personId, f.periodId);

    markSubmissionStarted(f.personId, f.periodId);

    const row = db
      .prepare('SELECT status FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?')
      .get(f.personId, f.periodId) as { status: string };

    expect(row.status).toBe('BEVESTIGD');
  });

  it('leaves an already-BEZIG row untouched (idempotent)', () => {
    const f = track(createFixture());
    markSubmissionStarted(f.personId, f.periodId);
    markSubmissionStarted(f.personId, f.periodId);

    const rows = db
      .prepare('SELECT status FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?')
      .all(f.personId, f.periodId) as Array<{ status: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('BEZIG');
  });
});
