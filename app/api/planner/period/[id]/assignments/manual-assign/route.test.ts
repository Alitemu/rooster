import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST as manualAssign } from './route';
import { POST as reassign } from '../[assignment-id]/reassign/route';

/**
 * The hard rules: a manual assignment only ever lands on a slot of the
 * period it is filed under, and only for someone the planner's own
 * dropdown would have offered - an active member of that period's pool.
 *
 * Nothing else in this route is a hard block (a blocked day, a window
 * conflict: those are overrides a planner may make on purpose), which is
 * exactly why these two have to hold: they are not overrides, they are a
 * request that makes no sense. A slot id from another period produced an
 * assignment in this roster for a date it doesn't cover; a person from
 * another pool (or a deactivated one) was put on it as if they belonged.
 */

interface Fixture {
  poolId: string;
  plannerId: string;
  memberId: string;
  outsiderId: string;
  periodId: string;
  slotId: string;
  otherPeriodId: string;
  otherSlotId: string;
}

const createdPoolIds: string[] = [];

function createPeriod(poolId: string, shiftTypeId: string, start: string, end: string): { periodId: string; slotId: string } {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'P', ?, ?, '2099-01-01T00:00:00Z', 'GEGENEREERD', datetime('now'))`
  ).run(periodId, poolId, start, end);
  const slotId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot
       (id, period_id, shift_type_id, datum, iso_jaar, iso_week, benodigd_aantal_personen)
     VALUES (?, ?, ?, ?, 2027, 9, 1)`
  ).run(slotId, periodId, shiftTypeId, start);
  return { periodId, slotId };
}

function createPerson(rol: 'DEELNEMER' | 'PLANNER'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(id, `T-${id.slice(0, 8)}`, rol);
  return id;
}

function createFixture(): Fixture {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`
  ).run(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Pool', ?, datetime('now'))`
  ).run(poolId, rulesetId);
  createdPoolIds.push(poolId);
  const shiftTypeId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`
  ).run(shiftTypeId, poolId);

  const plannerId = createPerson('PLANNER');
  const memberId = createPerson('DEELNEMER');
  const outsiderId = createPerson('DEELNEMER');
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
  ).run(crypto.randomUUID(), memberId, poolId);

  const { periodId, slotId } = createPeriod(poolId, shiftTypeId, '2027-03-01', '2027-03-14');
  const other = createPeriod(poolId, shiftTypeId, '2027-04-05', '2027-04-18');
  return {
    poolId,
    plannerId,
    memberId,
    outsiderId,
    periodId,
    slotId,
    otherPeriodId: other.periodId,
    otherSlotId: other.slotId,
  };
}

function plannerRequest(url: string, plannerId: string, body: unknown): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(url, {
    method: 'POST',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function assign(f: Fixture, periodId: string, slotId: string, personId: string) {
  return manualAssign(
    plannerRequest(`http://localhost/api/planner/period/${periodId}/assignments/manual-assign`, f.plannerId, {
      person_id: personId,
      slot_id: slotId,
    }),
    { params: Promise.resolve({ id: periodId }) }
  );
}

function assignmentCount(periodId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM dienstrooster_assignment WHERE schedule_version_id = ?').get(periodId) as {
      c: number;
    }
  ).c;
}

afterEach(() => {
  while (createdPoolIds.length > 0) {
    const poolId = createdPoolIds.pop()!;
    const periodIds = (
      db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?').all(poolId) as Array<{ id: string }>
    ).map((r) => r.id);
    for (const periodId of periodIds) {
      db.prepare('DELETE FROM dienstrooster_pending_undo WHERE scope_id = ?').run(periodId);
      db.prepare('DELETE FROM dienstrooster_assignment_edit WHERE periode_id = ?').run(periodId);
      db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId);
      db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
      db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
    }
    db.prepare('DELETE FROM dienstrooster_audit_log').run();
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as {
      ruleset_id: string;
    };
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  db.prepare(`DELETE FROM dienstrooster_person WHERE codenaam LIKE 'T-%'`).run();
});

describe('POST /api/planner/period/[id]/assignments/manual-assign', () => {
  it('assigns a pool member to a slot of this period', async () => {
    const f = createFixture();
    const res = await assign(f, f.periodId, f.slotId, f.memberId);
    expect(res.status).toBe(200);
    expect(assignmentCount(f.periodId)).toBe(1);
  });

  it('refuses a slot that belongs to a different period', async () => {
    const f = createFixture();
    const res = await assign(f, f.periodId, f.otherSlotId, f.memberId);
    expect(res.status).toBe(404);
    expect(assignmentCount(f.periodId)).toBe(0);
  });

  it('refuses someone who is not a member of this pool', async () => {
    const f = createFixture();
    const res = await assign(f, f.periodId, f.slotId, f.outsiderId);
    expect(res.status).toBe(400);
    expect(assignmentCount(f.periodId)).toBe(0);
  });

  it('refuses a member who has been deactivated', async () => {
    const f = createFixture();
    db.prepare('UPDATE dienstrooster_person SET actief = 0 WHERE id = ?').run(f.memberId);
    const res = await assign(f, f.periodId, f.slotId, f.memberId);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/planner/period/[id]/assignments/[assignment-id]/reassign', () => {
  it('refuses to hand an existing shift to someone outside the pool', async () => {
    const f = createFixture();
    await assign(f, f.periodId, f.slotId, f.memberId);
    const assignment = db
      .prepare('SELECT id FROM dienstrooster_assignment WHERE schedule_version_id = ?')
      .get(f.periodId) as { id: string };

    const res = await reassign(
      plannerRequest(
        `http://localhost/api/planner/period/${f.periodId}/assignments/${assignment.id}/reassign`,
        f.plannerId,
        { person_id: f.outsiderId }
      ),
      { params: Promise.resolve({ id: f.periodId, 'assignment-id': assignment.id }) }
    );
    expect(res.status).toBe(400);
    const after = db
      .prepare('SELECT person_id FROM dienstrooster_assignment WHERE schedule_version_id = ?')
      .get(f.periodId) as { person_id: string };
    expect(after.person_id).toBe(f.memberId);
  });
});
