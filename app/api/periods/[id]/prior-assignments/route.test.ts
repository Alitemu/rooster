import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { PATCH } from './route';

/**
 * The hard rule: a manually-entered prior-assignment date is always a real
 * ISO date before it reaches getISOWeek(parseISO(datum)).
 *
 * A value that is not a date parses to Invalid Date, whose ISO year/week
 * are both NaN - which better-sqlite3 silently binds as NULL. iso_jaar and
 * iso_week are NOT NULL columns, so this used to surface as a raw 500
 * instead of the actual problem. The stakes are higher than a crash: these
 * two columns are exactly what the window rule and holiday-spread checks
 * use to place this row against the next period's own slots
 * (lib/windowRule.ts) - a row that got through with corrupted values would
 * poison that person's fairness check for the whole following roster
 * without erroring anywhere.
 */

const createdPersonIds: string[] = [];
const createdPoolIds: string[] = [];
const createdRulesetIds: string[] = [];
const createdPeriodIds: string[] = [];

function createPool(): string {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Test ruleset', JSON.stringify({}));
  createdRulesetIds.push(rulesetId);

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Test pool', rulesetId);
  createdPoolIds.push(poolId);
  return poolId;
}

function createPerson(rol: 'DEELNEMER' | 'PLANNER' = 'DEELNEMER'): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`, rol);
  createdPersonIds.push(personId);
  return personId;
}

function createPeriod(poolId: string): string {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'P', '2027-01-04', '2027-01-17', '2099-01-01T00:00:00Z', 'OPEN', datetime('now'))`
  ).run(periodId, poolId);
  createdPeriodIds.push(periodId);
  return periodId;
}

function plannerRequest(periodId: string, plannerId: string, body: unknown): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost/api/periods/${periodId}/prior-assignments`, {
    method: 'PATCH',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rowCount(periodId: string): number {
  return (
    db.prepare('SELECT COUNT(*) c FROM dienstrooster_prior_assignment WHERE period_id = ?').get(periodId) as {
      c: number;
    }
  ).c;
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_prior_assignment WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  while (createdPersonIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(createdPersonIds.pop()!);
  }
  while (createdPoolIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(createdPoolIds.pop()!);
  }
  while (createdRulesetIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(createdRulesetIds.pop()!);
  }
});

describe('PATCH /api/periods/[id]/prior-assignments', () => {
  it.each([
    ['plain nonsense', 'xx'],
    ['Dutch day-first notation', '05-03-2027'],
    ['a year on its own', '2027'],
    ['a day that does not exist', '2027-02-30'],
  ])('refuses %s as datum, never touching the database', async (_label, datum) => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const periodId = createPeriod(poolId);

    const res = await PATCH(plannerRequest(periodId, planner, { datum, teller: 'AVOND' }), {
      params: Promise.resolve({ id: periodId }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_DATE');
    expect(rowCount(periodId)).toBe(0);
  });

  it('accepts a real date and inserts a correctly-computed iso_jaar/iso_week', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const periodId = createPeriod(poolId);

    const res = await PATCH(plannerRequest(periodId, planner, { datum: '2027-01-04', teller: 'AVOND' }), {
      params: Promise.resolve({ id: periodId }),
    });

    expect(res.status).toBe(200);
    const row = db
      .prepare('SELECT datum, iso_jaar, iso_week FROM dienstrooster_prior_assignment WHERE period_id = ?')
      .get(periodId) as { datum: string; iso_jaar: number; iso_week: number };
    expect(row).toEqual({ datum: '2027-01-04', iso_jaar: 2027, iso_week: 1 });
  });
});
