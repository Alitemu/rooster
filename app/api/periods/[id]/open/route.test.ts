import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  STAFF_SESSION_MAX_AGE_SECONDS,
} from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST } from './route';

/**
 * The hard rule: the route that freezes a ruleset onto a period refuses
 * every value PATCH .../ruleset would refuse.
 *
 * This is the half that was missing. Opening a period is where the ruleset
 * the first generate runs against is decided, and it only ever looked at
 * the bands - accepting fractional ones, any window at all, and an
 * objectiveMode that matches no branch. lib/rulesetValidation.test.ts
 * covers the rules themselves; this proves this route actually applies
 * them, so removing the call here cannot pass unnoticed.
 */

const createdPeriodIds: string[] = [];
const createdPoolIds: string[] = [];
const createdRulesetIds: string[] = [];
const createdPersonIds: string[] = [];

const START = '2029-01-01';
const END = '2029-02-25';
const DEADLINE = '2028-12-01T12:00:00.000Z';

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

  // Same four the seed creates; the route refuses a pool without them.
  for (const [naam, teller] of [
    ['Avonddienst', 'AVOND'],
    ['Zaterdag', 'WEEKEND'],
    ['Zondag', 'WEEKEND'],
    ['Feestdag', 'FEESTDAG'],
  ]) {
    db.prepare(
      `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, ?, ?)`
    ).run(crypto.randomUUID(), poolId, naam, teller);
  }
  return poolId;
}

function createStaff(): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'PLANNER', 1, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`);
  createdPersonIds.push(personId);
  return personId;
}

/** The route refuses a period with nobody active to fill it, so give it members. */
function createMembers(poolId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const personId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
    ).run(personId, `Test-${personId.slice(0, 8)}`);
    createdPersonIds.push(personId);
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, 1, '2000-01-01', '2100-01-01')`
    ).run(crypto.randomUUID(), personId, poolId);
  }
}

function createConceptPeriod(poolId: string): string {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'Testperiode', ?, ?, ?, 'CONCEPT', datetime('now'))`
  ).run(periodId, poolId, START, END, DEADLINE);
  createdPeriodIds.push(periodId);
  return periodId;
}

const VALID_RULESET = {
  windowWeeks: 2,
  bandAvond: [4, 6],
  bandWeekend: [1, 3],
  bandFeestdag: [0, 2],
  distributionMode: 'EVEN',
  blockBudget: {
    AVOND: { maxFraction: 0.5 },
    WEEKEND: { maxFraction: 0.5 },
    FEESTDAG: { maxFraction: 0.5 },
    parttimeExempt: true,
  },
};

function open(periodId: string, staffId: string, ruleset: Record<string, unknown>) {
  return openWithBody(periodId, staffId, { start_datum: START, eind_datum: END, ruleset });
}

function openWithBody(periodId: string, staffId: string, overrides: Record<string, unknown>) {
  const token = createSessionToken(
    { kind: 'staff', personId: staffId, sessionVersion: getSessionVersion(staffId)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  const req = new NextRequest(`http://localhost/api/periods/${periodId}/open`, {
    method: 'POST',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      naam: 'Testperiode',
      deadline: DEADLINE,
      ...overrides,
    }),
  });
  return POST(req, { params: Promise.resolve({ id: periodId }) });
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare(
      'DELETE FROM dienstrooster_availability WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)'
    ).run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_period_excluded_day WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_prior_assignment WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  for (const poolId of createdPoolIds) {
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(poolId);
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

describe('POST /api/periods/[id]/open — ruleset validation', () => {
  it('opens the period when the ruleset is sound', async () => {
    const poolId = createPool();
    createMembers(poolId, 20);
    const periodId = createConceptPeriod(poolId);

    const res = await open(periodId, createStaff(), VALID_RULESET);
    expect(res.status).toBe(200);

    const row = db
      .prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { status: string };
    expect(row.status).toBe('OPEN');
  });

  it.each([
    ['a fractional band', { bandAvond: [7.5, 8.5] }, 'INVALID_BAND'],
    ['a fractional window', { windowWeeks: 2.5 }, 'INVALID_WINDOW'],
    ['a negative window', { windowWeeks: -3 }, 'INVALID_WINDOW'],
    ['a window past the cap', { windowWeeks: 1000 }, 'INVALID_WINDOW'],
    [
      'a budget above 100%',
      { blockBudget: { ...VALID_RULESET.blockBudget, AVOND: { maxFraction: 9 } } },
      'INVALID_BUDGET',
    ],
    ['an unknown optimisation method', { objectiveMode: 'magie' }, 'INVALID_OBJECTIVE_MODE'],
    ['zero attempts', { maxAttempts: 0 }, 'INVALID_WEIGHT'],
    ['a negative penalty', { softBlockPenalty: -5 }, 'INVALID_WEIGHT'],
  ])('refuses %s, and leaves the period in CONCEPT', async (_label, override, expectedCode) => {
    const poolId = createPool();
    createMembers(poolId, 20);
    const periodId = createConceptPeriod(poolId);

    const res = await open(periodId, createStaff(), { ...VALID_RULESET, ...override });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(expectedCode);

    // The real damage a bad ruleset does is being frozen onto the period,
    // so check the period never moved rather than only the status code.
    const row = db
      .prepare('SELECT status, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { status: string; bevroren_ruleset_json: string | null };
    expect(row.status).toBe('CONCEPT');
    expect(row.bevroren_ruleset_json).toBeNull();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_shift_slot WHERE period_id = ?').get(periodId)
    ).toEqual({ n: 0 });
  });

  it('still requires all three bands', async () => {
    const poolId = createPool();
    createMembers(poolId, 20);
    const periodId = createConceptPeriod(poolId);

    const { bandFeestdag: _omitted, ...withoutOneBand } = VALID_RULESET;
    const res = await open(periodId, createStaff(), withoutOneBand);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_BAND');
  });
});

describe('POST /api/periods/[id]/open — date validation', () => {
  /**
   * parseISO does not reject a bad string, it returns Invalid Date -
   * dateToISO(Invalid Date) is the literal string "NaN-NaN-NaN", and
   * comparing two Invalid Dates with >= is always false. Nothing else in
   * this route re-checked that start_datum/eind_datum were real dates
   * before freezing them onto the period, so both a garbage value and a
   * value that merely parses wrong (Dutch day-first notation, a bare
   * year) used to sail straight through into the one column every
   * membership/capacity/slot-generation query in the app compares against
   * from then on.
   */
  it.each([
    ['plain nonsense', 'xx', '2029-02-25'],
    ['Dutch day-first notation', '01-03-2029', '2029-02-25'],
    ['a year on its own', '2029', '2029-02-25'],
    ['a day that does not exist', '2029-02-30', '2029-03-15'],
  ])('refuses %s as start_datum, and leaves the period in CONCEPT', async (_label, start_datum, eind_datum) => {
    const poolId = createPool();
    createMembers(poolId, 20);
    const periodId = createConceptPeriod(poolId);

    const res = await openWithBody(periodId, createStaff(), {
      start_datum,
      eind_datum,
      ruleset: VALID_RULESET,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_DATE');

    const row = db
      .prepare('SELECT status, start_datum FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { status: string; start_datum: string };
    expect(row.status).toBe('CONCEPT');
    // The actual failure mode this guards: the corrupted value must never
    // reach the period row, not even as a rejected-but-written attempt.
    expect(row.start_datum).not.toBe('NaN-NaN-NaN');
  });

  it('refuses a garbage eind_datum the same way', async () => {
    const poolId = createPool();
    createMembers(poolId, 20);
    const periodId = createConceptPeriod(poolId);

    const res = await openWithBody(periodId, createStaff(), {
      start_datum: START,
      eind_datum: 'niet-een-datum',
      ruleset: VALID_RULESET,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_DATE');
  });
});
