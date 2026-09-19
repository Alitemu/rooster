import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  PERSON_SESSION_MAX_AGE_SECONDS,
  STAFF_SESSION_MAX_AGE_SECONDS,
} from '@/lib/session';
import { GET } from './route';

/**
 * The hard rule: a participant only ever sees a period they belong to, and
 * only the fields their own page renders.
 *
 * Both halves matter. Reading someone else's period by id is a plain
 * access-control hole; the frozen ruleset inside it is worse than it looks,
 * because it spells out the solver's penalties and budgets - i.e. how to
 * shape your own preferences to get what you want.
 */

const createdPeriodIds: string[] = [];
const createdPoolIds: string[] = [];
const createdRulesetIds: string[] = [];
const createdPersonIds: string[] = [];

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

/**
 * Every DEELNEMER needs at least one live link for lib/auth-context.ts to
 * accept their session at all - this is the "some other period" one, so it
 * never doubles as access to the period under test.
 */
function createUnrelatedLink(personId: string): void {
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op)
     VALUES (?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, hashToken(`unrelated-${crypto.randomUUID()}`));
}

function createLinkForPeriod(personId: string, periodId: string): void {
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link
       (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, periodId, hashToken(`link-${crypto.randomUUID()}`));
}

function createMembership(poolId: string, personId: string): void {
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, 1, '2000-01-01', '2100-01-01')`
  ).run(crypto.randomUUID(), personId, poolId);
}

const FROZEN_RULESET = JSON.stringify({ windowWeeks: 2, softBlockPenalty: 3.0 });

function createPeriod(poolId: string): string {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'P', '2027-01-04', '2027-01-17', '2099-01-01T00:00:00Z', 'OPEN', ?, datetime('now'))`
  ).run(periodId, poolId, FROZEN_RULESET);
  createdPeriodIds.push(periodId);
  return periodId;
}

function request(periodId: string, personId: string, kind: 'person' | 'staff'): NextRequest {
  const maxAge = kind === 'staff' ? STAFF_SESSION_MAX_AGE_SECONDS : PERSON_SESSION_MAX_AGE_SECONDS;
  const token = createSessionToken({ kind, personId } as never, maxAge);
  return new NextRequest(`http://localhost/api/periods/${periodId}`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

function get(periodId: string, personId: string, kind: 'person' | 'staff' = 'person') {
  return GET(request(periodId, personId, kind), { params: Promise.resolve({ id: periodId }) });
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    // Links first: geldt_voor_periode_id is a foreign key onto the period.
    const periodId = createdPeriodIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  for (const poolId of createdPoolIds) {
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
  }
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
  while (createdPoolIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(createdPoolIds.pop()!);
  }
  while (createdRulesetIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(createdRulesetIds.pop()!);
  }
});

describe('GET /api/periods/[id]', () => {
  it('hides a period the participant has nothing to do with', async () => {
    const outsider = createPerson();
    createUnrelatedLink(outsider);
    const periodId = createPeriod(createPool());

    const res = await get(periodId, outsider);
    expect(res.status).toBe(404);
  });

  it('never returns the frozen ruleset to a participant, even their own period', async () => {
    const poolId = createPool();
    const participant = createPerson();
    createUnrelatedLink(participant);
    createMembership(poolId, participant);
    const periodId = createPeriod(poolId);

    const res = await get(periodId, participant);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.bevroren_ruleset_json).toBeUndefined();
    // Proof the field really is populated - otherwise the assertion above
    // would pass for a period that simply has no ruleset frozen yet.
    const stored = db
      .prepare('SELECT bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { bevroren_ruleset_json: string };
    expect(stored.bevroren_ruleset_json).toBe(FROZEN_RULESET);
  });

  it('gives a participant the fields their own page renders', async () => {
    const poolId = createPool();
    const participant = createPerson();
    createUnrelatedLink(participant);
    createMembership(poolId, participant);
    const periodId = createPeriod(poolId);

    const body = await (await get(periodId, participant)).json();
    expect(body.data).toEqual({
      id: periodId,
      naam: 'P',
      start_datum: '2027-01-04',
      eind_datum: '2027-01-17',
      deadline: '2099-01-01T00:00:00Z',
      status: 'OPEN',
    });
  });

  it('accepts a link issued for the period even after the pool membership ended', async () => {
    // Someone who has left the ward still has to be able to read the
    // roster they are in, so the invitation link stays sufficient on its
    // own.
    const poolId = createPool();
    const leaver = createPerson();
    createUnrelatedLink(leaver);
    const periodId = createPeriod(poolId);
    createLinkForPeriod(leaver, periodId);

    expect((await get(periodId, leaver)).status).toBe(200);
  });

  it('still gives the planner the full record, including the frozen ruleset', async () => {
    const planner = createPerson('PLANNER');
    const periodId = createPeriod(createPool());

    const body = await (await get(periodId, planner, 'staff')).json();
    expect(body.data.bevroren_ruleset_json).toBe(FROZEN_RULESET);
    expect(body.data.row_version).toBeDefined();
  });
});
