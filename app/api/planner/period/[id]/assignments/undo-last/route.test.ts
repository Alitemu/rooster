import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST as manualAssign } from '../manual-assign/route';
import { POST as reassign } from '../[assignment-id]/reassign/route';
import { DELETE as deleteAssignment } from '../[assignment-id]/delete/route';
import { POST as undoLast } from './route';
import { GET as pendingUndo } from '../pending-undo/route';

/**
 * The hard rule this file exists to prove: undoing the last action reverses
 * exactly that action and nothing else - a different slot changed earlier
 * in the same period is left untouched (lib/pendingUndo.ts is a single
 * last-action slot, not a stack), and an undo whose target has moved on
 * since (something else touched the same slot) is refused rather than
 * silently overwriting whatever is there now.
 */

interface Fixture {
  periodId: string;
  poolId: string;
  plannerId: string;
  personIds: string[];
  slotIds: string[];
}

function createFixture(personCount: number): Fixture {
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

  const plannerId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'PLANNER', 1, datetime('now'))`
  ).run(plannerId, `Planner-${plannerId.slice(0, 8)}`);

  const personIds: string[] = [];
  for (let i = 0; i < personCount; i++) {
    const personId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', datetime('now'))`
    ).run(personId, `Test-${personId.slice(0, 8)}`);
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
    ).run(crypto.randomUUID(), personId, poolId);
    personIds.push(personId);
  }

  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'Test period', '2027-03-01', '2027-03-14', '2099-01-01T00:00:00Z', 'GEGENEREERD', datetime('now'))`
  ).run(periodId, poolId);

  const slotIds: string[] = [];
  for (const datum of ['2027-03-01', '2027-03-02']) {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot
         (id, period_id, shift_type_id, datum, iso_jaar, iso_week, benodigd_aantal_personen)
       VALUES (?, ?, ?, ?, 2027, 9, 1)`
    ).run(id, periodId, shiftTypeId, datum);
    slotIds.push(id);
  }

  createdPeriodIds.push(periodId);
  createdPersonIds.push(plannerId);
  return { periodId, poolId, plannerId, personIds, slotIds };
}

function plannerRequest(url: string, plannerId: string, init: { method: string; body?: unknown }): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(url, {
    method: init.method,
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

function assignmentFor(periodId: string, slotId: string): { id: string; person_id: string } | undefined {
  return db
    .prepare('SELECT id, person_id FROM dienstrooster_assignment WHERE schedule_version_id = ? AND slot_id = ?')
    .get(periodId, slotId) as { id: string; person_id: string } | undefined;
}

async function doManualAssign(f: Fixture, slotId: string, personId: string) {
  return manualAssign(
    plannerRequest(`http://localhost/api/planner/period/${f.periodId}/assignments/manual-assign`, f.plannerId, {
      method: 'POST',
      body: { person_id: personId, slot_id: slotId },
    }),
    { params: Promise.resolve({ id: f.periodId }) }
  );
}

async function doReassign(f: Fixture, assignmentId: string, personId: string) {
  return reassign(
    plannerRequest(
      `http://localhost/api/planner/period/${f.periodId}/assignments/${assignmentId}/reassign`,
      f.plannerId,
      { method: 'POST', body: { person_id: personId } }
    ),
    { params: Promise.resolve({ id: f.periodId, 'assignment-id': assignmentId }) }
  );
}

async function doDelete(f: Fixture, assignmentId: string) {
  return deleteAssignment(
    plannerRequest(
      `http://localhost/api/planner/period/${f.periodId}/assignments/${assignmentId}/delete`,
      f.plannerId,
      { method: 'DELETE', body: {} }
    ),
    { params: Promise.resolve({ id: f.periodId, 'assignment-id': assignmentId }) }
  );
}

async function doUndo(f: Fixture) {
  return undoLast(
    plannerRequest(`http://localhost/api/planner/period/${f.periodId}/assignments/undo-last`, f.plannerId, {
      method: 'POST',
      body: {},
    }),
    { params: Promise.resolve({ id: f.periodId }) }
  );
}

async function doPending(f: Fixture) {
  return pendingUndo(
    plannerRequest(`http://localhost/api/planner/period/${f.periodId}/assignments/pending-undo`, f.plannerId, {
      method: 'GET',
    }),
    { params: Promise.resolve({ id: f.periodId }) }
  );
}

const createdPeriodIds: string[] = [];
const createdPersonIds: string[] = [];

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    const period = db
      .prepare('SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { pool_id: string } | undefined;
    if (!period) continue;
    db.prepare('DELETE FROM dienstrooster_pending_undo WHERE scope_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_assignment_edit WHERE periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_audit_log').run();
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
    const memberIds = db
      .prepare('SELECT person_id FROM dienstrooster_pool_membership WHERE pool_id = ?')
      .all(period.pool_id) as Array<{ person_id: string }>;
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(period.pool_id);
    for (const m of memberIds) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(m.person_id);
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(period.pool_id);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(period.pool_id) as
      | { ruleset_id: string }
      | undefined;
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(period.pool_id);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  while (createdPersonIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(createdPersonIds.pop()!);
  }
});

describe('POST /api/planner/period/[id]/assignments/undo-last', () => {
  it('undoing a fresh ASSIGN removes exactly that assignment', async () => {
    const f = createFixture(2);
    const assignRes = await doManualAssign(f, f.slotIds[0], f.personIds[0]);
    expect(assignRes.status).toBe(200);
    expect(assignmentFor(f.periodId, f.slotIds[0])).toBeDefined();

    const undoRes = await doUndo(f);
    expect(undoRes.status).toBe(200);
    expect(assignmentFor(f.periodId, f.slotIds[0])).toBeUndefined();

    const pendingAfter = await (await doPending(f)).json();
    expect(pendingAfter.data.pending).toBeNull();
  });

  it('undoing a REASSIGN restores the previous person, not the one before that', async () => {
    const f = createFixture(3);
    const firstAssign = await (await doManualAssign(f, f.slotIds[0], f.personIds[0])).json();
    await doReassign(f, firstAssign.data.assignment.id, f.personIds[1]);

    const undoRes = await doUndo(f);
    expect(undoRes.status).toBe(200);
    const current = assignmentFor(f.periodId, f.slotIds[0]);
    expect(current?.person_id).toBe(f.personIds[0]);
  });

  it('undoing a REMOVE re-creates the assignment for that exact person', async () => {
    const f = createFixture(2);
    const created = await (await doManualAssign(f, f.slotIds[0], f.personIds[0])).json();
    await doDelete(f, created.data.assignment.id);
    expect(assignmentFor(f.periodId, f.slotIds[0])).toBeUndefined();

    const undoRes = await doUndo(f);
    expect(undoRes.status).toBe(200);
    const restored = assignmentFor(f.periodId, f.slotIds[0]);
    expect(restored?.person_id).toBe(f.personIds[0]);
  });

  it('undoing only touches the most recent change - an earlier change to a different slot survives untouched', async () => {
    const f = createFixture(2);
    // Action 1: assign slot A to person 0.
    await doManualAssign(f, f.slotIds[0], f.personIds[0]);
    // Action 2: assign slot B to person 1 - this is now the only pending undo.
    await doManualAssign(f, f.slotIds[1], f.personIds[1]);

    const undoRes = await doUndo(f);
    expect(undoRes.status).toBe(200);

    // Slot B (the last action) was undone.
    expect(assignmentFor(f.periodId, f.slotIds[1])).toBeUndefined();
    // Slot A (an earlier, different action) must be completely untouched.
    const slotA = assignmentFor(f.periodId, f.slotIds[0]);
    expect(slotA?.person_id).toBe(f.personIds[0]);
  });

  it('refuses to undo an ASSIGN if the assignment no longer exists (stale)', async () => {
    const f = createFixture(2);
    const created = await (await doManualAssign(f, f.slotIds[0], f.personIds[0])).json();
    // Simulate something else removing it in the meantime (e.g. a regenerate).
    db.prepare('DELETE FROM dienstrooster_assignment WHERE id = ?').run(created.data.assignment.id);

    const undoRes = await doUndo(f);
    expect(undoRes.status).toBe(409);
    const body = await undoRes.json();
    expect(body.error.code).toBe('UNDO_STALE');

    // The stale pending-undo row must be cleared, not left offering a
    // repeat of the same refused undo forever.
    const pendingAfter = await (await doPending(f)).json();
    expect(pendingAfter.data.pending).toBeNull();
  });

  it('refuses to undo a REMOVE if the slot has since been filled again', async () => {
    const f = createFixture(2);
    const created = await (await doManualAssign(f, f.slotIds[0], f.personIds[0])).json();
    await doDelete(f, created.data.assignment.id);
    // Filled again by something that doesn't go through this app's own
    // pending-undo bookkeeping (a solver regenerate, a direct DB fix) -
    // the pending-undo row still describes the now-stale REMOVE.
    db.prepare(
      `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
       VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
    ).run(crypto.randomUUID(), f.periodId, f.personIds[1], f.slotIds[0]);

    const undoRes = await doUndo(f);
    expect(undoRes.status).toBe(409);

    // The newer assignment (person 1) must be untouched by the refused undo.
    const current = assignmentFor(f.periodId, f.slotIds[0]);
    expect(current?.person_id).toBe(f.personIds[1]);
  });

  it('reports NOTHING_TO_UNDO once nothing is pending', async () => {
    const f = createFixture(1);
    const res = await doUndo(f);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOTHING_TO_UNDO');
  });

  it('pending-undo reports a human-readable label while an action is pending, and null once undone', async () => {
    const f = createFixture(1);
    await doManualAssign(f, f.slotIds[0], f.personIds[0]);
    const before = await (await doPending(f)).json();
    expect(typeof before.data.pending.label).toBe('string');
    expect(before.data.pending.label.length).toBeGreaterThan(0);

    await doUndo(f);
    const after = await (await doPending(f)).json();
    expect(after.data.pending).toBeNull();
  });
});
