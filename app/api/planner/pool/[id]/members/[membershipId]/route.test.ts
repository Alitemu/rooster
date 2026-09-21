import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { PATCH } from './route';

/**
 * The hard rule: a membership's geldig_vanaf/geldig_tot are always real
 * ISO dates, never just "the range check didn't complain".
 *
 * That check is `geldig_vanaf > geldig_tot`, a plain string comparison -
 * exactly right for two real YYYY-MM-DD values (they sort chronologically
 * as text) and silent for anything else ("xx" > "yy" is false). Every
 * query that decides whether this person is really in the pool for a given
 * period - capacity, generate-roster's headcount, band scaling, the
 * dashboard's progress list - compares this same column against period
 * dates the same way, so a corrupted value doesn't error anywhere
 * downstream. It just makes every one of those comparisons false, which
 * silently drops the person out of the pool with nothing to say why.
 */

const createdPoolIds: string[] = [];
const createdRulesetIds: string[] = [];
const createdPersonIds: string[] = [];
const createdMembershipIds: string[] = [];

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

function createMembership(poolId: string, personId: string, vanaf: string, tot: string): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, 1, ?, ?)`
  ).run(id, personId, poolId, vanaf, tot);
  createdMembershipIds.push(id);
  return id;
}

function plannerRequest(poolId: string, membershipId: string, plannerId: string, body: unknown): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost/api/planner/pool/${poolId}/members/${membershipId}`, {
    method: 'PATCH',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function currentDates(membershipId: string): { geldig_vanaf: string; geldig_tot: string } {
  return db
    .prepare('SELECT geldig_vanaf, geldig_tot FROM dienstrooster_pool_membership WHERE id = ?')
    .get(membershipId) as { geldig_vanaf: string; geldig_tot: string };
}

afterEach(() => {
  while (createdMembershipIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE id = ?').run(createdMembershipIds.pop()!);
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

describe('PATCH /api/planner/pool/[id]/members/[membershipId]', () => {
  it.each([
    ['plain nonsense', 'xx', 'yy'],
    ['Dutch day-first notation', '01-03-2027', '05-03-2027'],
    ['a year on its own', '2027', '2027'],
    ['a day that does not exist', '2027-02-30', '2027-03-01'],
  ])('refuses %s for geldig_vanaf/geldig_tot, and leaves the stored dates alone', async (_label, vanaf, tot) => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const person = createPerson();
    const membershipId = createMembership(poolId, person, '2027-01-01', '2027-12-31');

    const res = await PATCH(plannerRequest(poolId, membershipId, planner, { geldig_vanaf: vanaf, geldig_tot: tot }), {
      params: Promise.resolve({ id: poolId, membershipId }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_DATE');
    expect(currentDates(membershipId)).toEqual({ geldig_vanaf: '2027-01-01', geldig_tot: '2027-12-31' });
  });

  it('refuses a garbage geldig_vanaf even when geldig_tot is untouched', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const person = createPerson();
    const membershipId = createMembership(poolId, person, '2027-01-01', '2027-12-31');

    const res = await PATCH(plannerRequest(poolId, membershipId, planner, { geldig_vanaf: 'niet-een-datum' }), {
      params: Promise.resolve({ id: poolId, membershipId }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_DATE');
    expect(currentDates(membershipId).geldig_vanaf).toBe('2027-01-01');
  });

  it('accepts a real date change', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const person = createPerson();
    const membershipId = createMembership(poolId, person, '2027-01-01', '2027-12-31');

    const res = await PATCH(plannerRequest(poolId, membershipId, planner, { geldig_tot: '2027-06-30' }), {
      params: Promise.resolve({ id: poolId, membershipId }),
    });

    expect(res.status).toBe(200);
    expect(currentDates(membershipId)).toEqual({ geldig_vanaf: '2027-01-01', geldig_tot: '2027-06-30' });
  });

  it('still refuses a real range that runs backwards', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const person = createPerson();
    const membershipId = createMembership(poolId, person, '2027-01-01', '2027-12-31');

    const res = await PATCH(
      plannerRequest(poolId, membershipId, planner, { geldig_vanaf: '2027-12-01', geldig_tot: '2027-01-01' }),
      { params: Promise.resolve({ id: poolId, membershipId }) }
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_RANGE');
  });

  it('still refuses a real date that would overlap another membership for the same person', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const person = createPerson();
    createMembership(poolId, person, '2026-01-01', '2026-06-30');
    const membershipId = createMembership(poolId, person, '2027-01-01', '2027-12-31');

    const res = await PATCH(
      plannerRequest(poolId, membershipId, planner, { geldig_vanaf: '2026-03-01' }),
      { params: Promise.resolve({ id: poolId, membershipId }) }
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('MEMBERSHIP_OVERLAP');
  });
});
