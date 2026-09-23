import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST } from './route';

/**
 * The hard rules:
 * - a planner can submit on behalf of someone who never opened their own
 *   page. Their blocks can come entirely from a part-time pattern or an
 *   absence (synced when the period opened), so there is no submission row
 *   yet - and the INSERT for that case left out the NOT NULL aangemaakt_op,
 *   so it failed with a bare "Er is iets misgegaan" every time.
 * - once the roster has been generated, submitting no longer changes
 *   anything, and the planner is told so instead of it silently "working".
 */

const created = { pools: [] as string[], people: [] as string[] };

function createFixture(status = 'GESLOTEN') {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`
  ).run(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Pool', ?, datetime('now'))`
  ).run(poolId, rulesetId);
  created.pools.push(poolId);
  const shiftTypeId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`
  ).run(shiftTypeId, poolId);
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'P', '2027-01-04', '2027-01-10', '2026-12-01T17:00', ?, datetime('now'))`
  ).run(periodId, poolId, status);
  const slotId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
     VALUES (?, ?, ?, '2027-01-04', 2027, 1)`
  ).run(slotId, periodId, shiftTypeId);

  const plannerId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'PLANNER', 1, datetime('now'))`
  ).run(plannerId, `SOB-${plannerId.slice(0, 8)}`);
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
  ).run(personId, `SOB-${personId.slice(0, 8)}`);
  created.people.push(plannerId, personId);
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
  ).run(crypto.randomUUID(), personId, poolId);

  // A block that did not come from the person themselves (as a part-time
  // pattern's backfill at period open would produce) - so no submission
  // row exists for them.
  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
     VALUES (?, ?, ?, 'ABSOLUUT', 'MANUAL', datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId);

  return { plannerId, personId, periodId };
}

function submit(plannerId: string, personId: string, periodId: string) {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return POST(
    new NextRequest(`http://localhost/api/planner/person/${personId}/submit-on-behalf`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ period_id: periodId }),
    }),
    { params: Promise.resolve({ id: personId }) }
  );
}

afterEach(() => {
  for (const poolId of created.pools) {
    for (const { id } of db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?').all(poolId) as Array<{
      id: string;
    }>) {
      db.prepare(
        'DELETE FROM dienstrooster_availability WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)'
      ).run(id);
      db.prepare('DELETE FROM dienstrooster_submission WHERE schedule_period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as { ruleset_id: string };
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  for (const id of created.people) {
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
  created.pools = [];
  created.people = [];
});

describe('POST /api/planner/person/[id]/submit-on-behalf', () => {
  it('submits for someone who has no submission row yet, in a closed period', async () => {
    const f = createFixture('GESLOTEN');
    const res = await submit(f.plannerId, f.personId, f.periodId);
    expect(res.status).toBe(200);
    const row = db
      .prepare('SELECT status, aangemaakt_op FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?')
      .get(f.personId, f.periodId) as { status: string; aangemaakt_op: string };
    expect(row.status).toBe('BEVESTIGD');
    expect(row.aangemaakt_op).toBeTruthy();
  });

  it('refuses with a clear message once the roster has been generated', async () => {
    const f = createFixture('GEGENEREERD');
    const res = await submit(f.plannerId, f.personId, f.periodId);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ROSTER_ALREADY_GENERATED');
    expect(body.error.message).toMatch(/rooster is al gemaakt/);
  });
});
