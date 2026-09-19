import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST } from './route';

/**
 * Before this route existed, GEPUBLICEERD was a one-way door: publishing a
 * roster too early, or with something only noticed afterwards, was
 * permanent. This proves the way back works, and that it doesn't silently
 * throw away the roster or the record of what already happened.
 */

const createdPeriodIds: string[] = [];
const createdPoolIds: string[] = [];

function createPool(): { poolId: string; personId: string } {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Unpublish test', '{}');

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Unpublish test pool', rulesetId);
  createdPoolIds.push(poolId);

  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op)
     VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`);
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
  ).run(crypto.randomUUID(), personId, poolId);

  return { poolId, personId };
}

function createPlanner(): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op)
     VALUES (?, ?, 'PLANNER', 1, datetime('now'))`
  ).run(personId, `Planner-${personId.slice(0, 8)}`);
  return personId;
}

function createPeriod(poolId: string, status: string): string {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, gepubliceerd_op, gepubliceerd_door_person_id, aangemaakt_op)
     VALUES (?, ?, 'P', '2027-01-04', '2027-01-10', '2099-01-01T00:00:00Z', ?, ?, NULL, datetime('now'))`
  ).run(periodId, poolId, status, status === 'GEPUBLICEERD' ? '2027-01-01' : null);
  createdPeriodIds.push(periodId);
  return periodId;
}

function assignOne(periodId: string, personId: string): string {
  const shiftTypeId = crypto.randomUUID();
  const poolId = (db.prepare('SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as { pool_id: string }).pool_id;
  db.prepare(`INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`).run(shiftTypeId, poolId);
  const slotId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week, benodigd_aantal_personen)
     VALUES (?, ?, ?, '2027-01-05', 2027, 1, 1)`
  ).run(slotId, periodId, shiftTypeId);
  db.prepare(
    `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
  ).run(crypto.randomUUID(), periodId, personId, slotId);
  return slotId;
}

function post(periodId: string, plannerId: string) {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return POST(
    new NextRequest(`http://localhost/api/planner/period/${periodId}/unpublish`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }),
    { params: Promise.resolve({ id: periodId }) }
  );
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_notification WHERE periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId);
    const shiftTypeIds = db
      .prepare('SELECT DISTINCT shift_type_id FROM dienstrooster_shift_slot WHERE period_id = ?')
      .all(periodId) as Array<{ shift_type_id: string }>;
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    for (const st of shiftTypeIds) db.prepare('DELETE FROM dienstrooster_shift_type WHERE id = ?').run(st.shift_type_id);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  while (createdPoolIds.length > 0) {
    const poolId = createdPoolIds.pop()!;
    const members = db.prepare('SELECT person_id FROM dienstrooster_pool_membership WHERE pool_id = ?').all(poolId) as Array<{ person_id: string }>;
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    for (const m of members) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(m.person_id);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as { ruleset_id: string } | undefined;
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
});

describe('POST /api/planner/period/[id]/unpublish', () => {
  it('moves a published period back to GEGENEREERD and clears who/when it was published', async () => {
    const { poolId } = createPool();
    const planner = createPlanner();
    const periodId = createPeriod(poolId, 'GEPUBLICEERD');
    // gepubliceerd_door_person_id set to a real person here specifically,
    // so clearing it below proves the route actively resets the field
    // rather than it merely staying null because nothing set it.
    db.prepare('UPDATE dienstrooster_schedule_period SET gepubliceerd_door_person_id = ? WHERE id = ?').run(planner, periodId);

    const res = await post(periodId, planner);
    expect(res.status).toBe(200);

    const row = db.prepare('SELECT status, gepubliceerd_op, gepubliceerd_door_person_id FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as any;
    expect(row.status).toBe('GEGENEREERD');
    expect(row.gepubliceerd_op).toBeNull();
    expect(row.gepubliceerd_door_person_id).toBeNull();
  });

  it('refuses to unpublish a period that was never published', async () => {
    const { poolId } = createPool();
    const planner = createPlanner();
    const periodId = createPeriod(poolId, 'GEGENEREERD');

    const res = await post(periodId, planner);
    expect(res.status).toBe(400);

    const row = db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as { status: string };
    expect(row.status).toBe('GEGENEREERD');
  });

  it('keeps the assignments - withdrawing is not discarding the roster', async () => {
    const { poolId, personId } = createPool();
    const planner = createPlanner();
    const periodId = createPeriod(poolId, 'GEPUBLICEERD');
    assignOne(periodId, personId);

    await post(periodId, planner);

    const count = db.prepare('SELECT COUNT(*) AS c FROM dienstrooster_assignment WHERE schedule_version_id = ?').get(periodId) as { c: number };
    expect(count.c).toBe(1);
  });

  it('tells every pool member the publication was withdrawn', async () => {
    const { poolId, personId } = createPool();
    const planner = createPlanner();
    const periodId = createPeriod(poolId, 'GEPUBLICEERD');

    const res = await post(periodId, planner);
    const body = await res.json();
    expect(body.data.notifications_sent).toBe(1);

    const notif = db
      .prepare(`SELECT onderwerp, inhoud FROM dienstrooster_notification WHERE person_id = ? AND periode_id = ?`)
      .get(personId, periodId) as { onderwerp: string; inhoud: string };
    expect(notif.onderwerp).toContain('ingetrokken');
  });

  it('records the withdrawal in the audit trail', async () => {
    const { poolId } = createPool();
    const planner = createPlanner();
    const periodId = createPeriod(poolId, 'GEPUBLICEERD');

    await post(periodId, planner);

    const entry = db
      .prepare(`SELECT actor_id, oud_json, nieuw_json FROM dienstrooster_audit_log WHERE entiteit_id = ? AND actie = 'UPDATE'`)
      .get(periodId) as { actor_id: string; oud_json: string; nieuw_json: string };
    expect(entry.actor_id).toBe(planner);
    expect(JSON.parse(entry.oud_json).status).toBe('GEPUBLICEERD');
    expect(JSON.parse(entry.nieuw_json).status).toBe('GEGENEREERD');
  });

  it('lets the period be published again after being withdrawn', async () => {
    const { poolId, personId } = createPool();
    const planner = createPlanner();
    const periodId = createPeriod(poolId, 'GEPUBLICEERD');
    assignOne(periodId, personId);

    await post(periodId, planner);
    expect((db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as { status: string }).status).toBe('GEGENEREERD');

    const { POST: publish } = await import('../publish/route');
    const token = createSessionToken(
      { kind: 'staff', personId: planner, sessionVersion: getSessionVersion(planner)! } as never,
      STAFF_SESSION_MAX_AGE_SECONDS
    );
    const publishRes = await publish(
      new NextRequest(`http://localhost/api/planner/period/${periodId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${token}` },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: periodId }) }
    );
    expect(publishRes.status).toBe(200);
  });
});
