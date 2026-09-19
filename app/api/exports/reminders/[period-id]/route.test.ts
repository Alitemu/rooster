import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { POST } from './route';

/**
 * Generating reminders must not break links that were already sent.
 *
 * The plaintext token is never stored, so each export has to mint a new
 * link - but it adds one rather than retiring the earlier ones. This used
 * to revoke first, which meant opening this screen just to see who was
 * still outstanding silently invalidated the link in everyone's original
 * invitation mail, and the participant page renders that as "Ongeldige of
 * verlopen toegangslink".
 */

const createdPeriodIds: string[] = [];
const createdPoolIds: string[] = [];
// Tracked so the ruleset createPool() mints is cleaned up too - it has no
// FK pointing at it, so nothing else would ever remove it.
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

function createMembership(poolId: string, personId: string): void {
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, 1, '2000-01-01', '2100-01-01')`
  ).run(crypto.randomUUID(), personId, poolId);
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

/** An already-sent invitation link, as the invitations export would have left it. */
function createExistingLink(personId: string, periodId: string): string {
  const token = `existing-token-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link
       (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, periodId, hashToken(token));
  return token;
}

function isLinkLive(token: string): boolean {
  const row = db
    .prepare('SELECT ingetrokken_op FROM dienstrooster_person_access_link WHERE token_hash = ?')
    .get(hashToken(token)) as { ingetrokken_op: string | null } | undefined;
  return !!row && row.ingetrokken_op === null;
}

function plannerRequest(periodId: string, plannerId: string): NextRequest {
  const token = createSessionToken({ kind: 'staff', personId: plannerId }, STAFF_SESSION_MAX_AGE_SECONDS);
  return new NextRequest(`http://localhost/api/exports/reminders/${periodId}`, {
    method: 'POST',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_submission WHERE schedule_period_id = ?').run(periodId);
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

describe('POST /api/exports/reminders/[period-id]', () => {
  it('leaves an already-sent link working, so the original invitation mail stays usable', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const participant = createPerson();
    createMembership(poolId, participant);
    const periodId = createPeriod(poolId);
    const alreadySent = createExistingLink(participant, periodId);

    const res = await POST(plannerRequest(periodId, planner), {
      params: Promise.resolve({ 'period-id': periodId }),
    });
    expect(res.status).toBe(200);

    expect(isLinkLive(alreadySent)).toBe(true);
  });

  it('still issues a fresh working link, because the old token cannot be read back', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const participant = createPerson();
    createMembership(poolId, participant);
    const periodId = createPeriod(poolId);
    createExistingLink(participant, periodId);

    const res = await POST(plannerRequest(periodId, planner), {
      params: Promise.resolve({ 'period-id': periodId }),
    });
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    const issued = body.data[0].personal_link.split('/person/')[1];
    expect(isLinkLive(issued)).toBe(true);

    // Both are live at once: the new one and the one already in their inbox.
    const live = db
      .prepare(
        `SELECT COUNT(*) AS c FROM dienstrooster_person_access_link
         WHERE person_id = ? AND geldt_voor_periode_id = ? AND ingetrokken_op IS NULL`
      )
      .get(participant, periodId) as { c: number };
    expect(live.c).toBe(2);
  });

  it('generating reminders twice does not retire the first batch either', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const participant = createPerson();
    createMembership(poolId, participant);
    const periodId = createPeriod(poolId);

    const first = await POST(plannerRequest(periodId, planner), {
      params: Promise.resolve({ 'period-id': periodId }),
    });
    const firstToken = (await first.json()).data[0].personal_link.split('/person/')[1];

    await POST(plannerRequest(periodId, planner), {
      params: Promise.resolve({ 'period-id': periodId }),
    });

    expect(isLinkLive(firstToken)).toBe(true);
  });
});
