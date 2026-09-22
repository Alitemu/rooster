import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { DELETE as deleteMembership } from '../[membershipId]/route';
import { POST as undoLast } from './route';
import { GET as pendingUndo } from '../pending-undo/route';

/**
 * Same hard rule as the assignment undo tests: undoing a membership removal
 * restores exactly that membership, and is refused (not silently applied)
 * if the person has since gained an overlapping membership some other way.
 */

interface Fixture {
  poolId: string;
  plannerId: string;
  personId: string;
  membershipId: string;
}

const createdPoolIds: string[] = [];
const createdPersonIds: string[] = [];

function createFixture(): Fixture {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Test ruleset', '{}');

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Test pool', rulesetId);
  createdPoolIds.push(poolId);

  const plannerId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'PLANNER', 1, datetime('now'))`
  ).run(plannerId, `Planner-${plannerId.slice(0, 8)}`);
  createdPersonIds.push(plannerId);

  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`);
  createdPersonIds.push(personId);

  const membershipId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, 1, '2027-01-01', '2027-12-31')`
  ).run(membershipId, personId, poolId);

  return { poolId, plannerId, personId, membershipId };
}

function plannerRequest(url: string, plannerId: string, method: string): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(url, { method, headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` } });
}

function currentMembership(poolId: string, personId: string) {
  return db
    .prepare('SELECT id, geldig_vanaf, geldig_tot FROM dienstrooster_pool_membership WHERE pool_id = ? AND person_id = ?')
    .get(poolId, personId) as { id: string; geldig_vanaf: string; geldig_tot: string } | undefined;
}

afterEach(() => {
  while (createdPoolIds.length > 0) {
    const poolId = createdPoolIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_pending_undo WHERE scope_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as
      | { ruleset_id: string }
      | undefined;
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  while (createdPersonIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(createdPersonIds.pop()!);
  }
});

describe('POST /api/planner/pool/[id]/members/undo-last', () => {
  it('undoing a membership removal re-creates the exact same date range', async () => {
    const f = createFixture();
    const deleteRes = await deleteMembership(
      plannerRequest(`http://localhost/api/planner/pool/${f.poolId}/members/${f.membershipId}`, f.plannerId, 'DELETE'),
      { params: Promise.resolve({ id: f.poolId, membershipId: f.membershipId }) }
    );
    expect(deleteRes.status).toBe(200);
    expect(currentMembership(f.poolId, f.personId)).toBeUndefined();

    const undoRes = await undoLast(
      plannerRequest(`http://localhost/api/planner/pool/${f.poolId}/members/undo-last`, f.plannerId, 'POST'),
      { params: Promise.resolve({ id: f.poolId }) }
    );
    expect(undoRes.status).toBe(200);
    const restored = currentMembership(f.poolId, f.personId);
    expect(restored?.geldig_vanaf).toBe('2027-01-01');
    expect(restored?.geldig_tot).toBe('2027-12-31');
  });

  it('refuses to undo if the person has since gained an overlapping membership', async () => {
    const f = createFixture();
    await deleteMembership(
      plannerRequest(`http://localhost/api/planner/pool/${f.poolId}/members/${f.membershipId}`, f.plannerId, 'DELETE'),
      { params: Promise.resolve({ id: f.poolId, membershipId: f.membershipId }) }
    );
    // Someone re-adds this person to the pool (overlapping dates) some other way.
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, 1, '2027-06-01', '2027-06-30')`
    ).run(crypto.randomUUID(), f.personId, f.poolId);

    const undoRes = await undoLast(
      plannerRequest(`http://localhost/api/planner/pool/${f.poolId}/members/undo-last`, f.plannerId, 'POST'),
      { params: Promise.resolve({ id: f.poolId }) }
    );
    expect(undoRes.status).toBe(409);
    expect((await undoRes.json()).error.code).toBe('UNDO_STALE');

    // Exactly one membership row - the newer one - must exist, not two overlapping rows.
    const rows = db
      .prepare('SELECT COUNT(*) c FROM dienstrooster_pool_membership WHERE pool_id = ? AND person_id = ?')
      .get(f.poolId, f.personId) as { c: number };
    expect(rows.c).toBe(1);
  });

  it('pending-undo reports null once nothing is pending', async () => {
    const f = createFixture();
    const res = await pendingUndo(
      plannerRequest(`http://localhost/api/planner/pool/${f.poolId}/members/pending-undo`, f.plannerId, 'GET'),
      { params: Promise.resolve({ id: f.poolId }) }
    );
    expect((await res.json()).data.pending).toBeNull();
  });
});
