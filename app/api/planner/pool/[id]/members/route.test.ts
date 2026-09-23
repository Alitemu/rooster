import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST } from './route';

/**
 * The hard rules:
 * - only a participant can become a pool member. The route reuses an
 *   existing person by codenaam, and used to do so for any account - so
 *   typing the planner's own login name added the planner to the pool,
 *   where the solver counted them in the headcount and bands like anyone
 *   else.
 * - someone who joins while a period is already open gets their existing
 *   absences applied to it straight away. The period's own backfill ran
 *   when it opened, before this membership existed.
 */

const created = { pools: [] as string[], people: [] as string[] };

function createPerson(rol: 'DEELNEMER' | 'PLANNER'): { id: string; codenaam: string } {
  const id = crypto.randomUUID();
  const codenaam = `M-${id.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(id, codenaam, rol);
  created.people.push(id);
  return { id, codenaam };
}

function createPool(): { poolId: string; periodId: string; slotId: string } {
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
     VALUES (?, ?, 'P', '2027-03-01', '2027-03-07', '2099-01-01T00:00', 'OPEN', datetime('now'))`
  ).run(periodId, poolId);
  const slotId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
     VALUES (?, ?, ?, '2027-03-02', 2027, 9)`
  ).run(slotId, periodId, shiftTypeId);
  return { poolId, periodId, slotId };
}

function addMember(plannerId: string, poolId: string, codenaam: string) {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return POST(
    new NextRequest(`http://localhost/api/planner/pool/${poolId}/members`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ codenaam, geldig_vanaf: '2027-01-01', geldig_tot: '2027-12-31' }),
    }),
    { params: Promise.resolve({ id: poolId }) }
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
      db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as { ruleset_id: string };
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  for (const personId of created.people) {
    db.prepare('DELETE FROM dienstrooster_absence WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
  created.pools = [];
  created.people = [];
});

describe('POST /api/planner/pool/[id]/members', () => {
  it('refuses a codenaam that belongs to a planner account', async () => {
    const planner = createPerson('PLANNER');
    const otherPlanner = createPerson('PLANNER');
    const { poolId } = createPool();

    const res = await addMember(planner.id, poolId, otherPlanner.codenaam);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('STAFF_ACCOUNT');
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM dienstrooster_pool_membership WHERE person_id = ?')
      .get(otherPlanner.id) as { c: number };
    expect(count.c).toBe(0);
  });

  it('still reuses an existing participant by codenaam', async () => {
    const planner = createPerson('PLANNER');
    const participant = createPerson('DEELNEMER');
    const { poolId } = createPool();

    const res = await addMember(planner.id, poolId, participant.codenaam);
    expect(res.status).toBe(201);
    expect((await res.json()).data.person_id).toBe(participant.id);
  });

  it("applies the new member's existing absence to a period that is already open", async () => {
    const planner = createPerson('PLANNER');
    const participant = createPerson('DEELNEMER');
    const { poolId, slotId } = createPool();
    db.prepare(
      `INSERT INTO dienstrooster_absence (id, person_id, van_datum, tot_datum, soort, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, '2027-03-01', '2027-03-03', 'VAKANTIE', ?, datetime('now'))`
    ).run(crypto.randomUUID(), participant.id, participant.id);

    expect((await addMember(planner.id, poolId, participant.codenaam)).status).toBe(201);

    const row = db
      .prepare('SELECT blocking_level, source FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?')
      .get(participant.id, slotId);
    expect(row).toEqual({ blocking_level: 'ABSOLUUT', source: 'ABSENCE' });
  });
});
