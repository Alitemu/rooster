import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { getActiveReminderMilestones, resolveReminderUrgency } from '@/lib/reminderSchedule';

/**
 * A period's reminder milestones (dienstrooster_reminder_schedule) used to
 * be seeded and then never read - the reminders export computed urgency
 * from two numbers hardcoded in the route instead. This proves the table
 * is now the actual source of truth.
 */

const createdPeriodIds: string[] = [];

function createPeriod(): string {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, '{}', datetime('now'))`
  ).run(rulesetId, 'Test ruleset');

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Test pool', rulesetId);

  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'Test period', '2027-01-04', '2027-01-10', '2099-01-01T00:00:00Z', 'OPEN', datetime('now'))`
  ).run(periodId, poolId);

  createdPeriodIds.push(periodId);
  return periodId;
}

function addMilestone(periodId: string, dagen: number, actief: boolean) {
  db.prepare(
    `INSERT INTO dienstrooster_reminder_schedule (id, period_id, dagen_voor_deadline, actief)
     VALUES (?, ?, ?, ?)`
  ).run(crypto.randomUUID(), periodId, dagen, actief ? 1 : 0);
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_reminder_schedule WHERE period_id = ?').run(periodId);
    const period = db
      .prepare('SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { pool_id: string } | undefined;
    if (!period) continue;
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
    const pool = db
      .prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?')
      .get(period.pool_id) as { ruleset_id: string } | undefined;
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(period.pool_id);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
});

describe('getActiveReminderMilestones', () => {
  it('falls back to 21/7/1 when a period has no configured milestones', () => {
    const periodId = createPeriod();
    expect(getActiveReminderMilestones(periodId)).toEqual([21, 7, 1]);
  });

  it('returns configured milestones sorted furthest-out first, ignoring inactive rows', () => {
    const periodId = createPeriod();
    addMilestone(periodId, 3, true);
    addMilestone(periodId, 10, true);
    addMilestone(periodId, 30, false); // inactive - excluded
    expect(getActiveReminderMilestones(periodId)).toEqual([10, 3]);
  });
});

describe('resolveReminderUrgency', () => {
  const milestones = [21, 7, 1];

  it('is urgent at or past the smallest milestone', () => {
    expect(resolveReminderUrgency(1, milestones)).toBe('urgent');
    expect(resolveReminderUrgency(0, milestones)).toBe('urgent');
  });

  it('is gentle at or beyond the largest milestone', () => {
    expect(resolveReminderUrgency(21, milestones)).toBe('gentle');
    expect(resolveReminderUrgency(40, milestones)).toBe('gentle');
  });

  it('is moderate strictly between the smallest and largest milestone', () => {
    expect(resolveReminderUrgency(7, milestones)).toBe('moderate');
    expect(resolveReminderUrgency(14, milestones)).toBe('moderate');
  });

  it('has no moderate tier with a single milestone - it is either urgent or gentle', () => {
    expect(resolveReminderUrgency(5, [7])).toBe('urgent');
    expect(resolveReminderUrgency(7, [7])).toBe('urgent');
    expect(resolveReminderUrgency(8, [7])).toBe('gentle');
  });
});
