import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET, POST } from './route';
import { PATCH } from './[membershipId]/route';

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

function plannerCookie(plannerId: string): string {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function addMember(plannerId: string, poolId: string, codenaam: string, extra: Record<string, unknown> = {}) {
  return POST(
    new NextRequest(`http://localhost/api/planner/pool/${poolId}/members`, {
      method: 'POST',
      headers: { Cookie: plannerCookie(plannerId), 'Content-Type': 'application/json' },
      body: JSON.stringify({ codenaam, geldig_vanaf: '2027-01-01', geldig_tot: '2027-12-31', ...extra }),
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
      db.prepare('DELETE FROM dienstrooster_submission WHERE schedule_period_id = ?').run(id);
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
    db.prepare('DELETE FROM dienstrooster_parttime_pattern WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(personId);
    // Audit rows they wrote as planner point at them (lib/auditLog.ts).
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(personId);
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

  // Audit 13: re-adding someone with their codenaam typed in other capitals
  // made a second person. Their carry-over, feestdagdiensten over the years
  // and the flow's row for their mail stayed with the first; the planner
  // saw two people who looked like one.
  it('refuses a codenaam that differs from an existing one only in capitals', async () => {
    const planner = createPerson('PLANNER');
    const participant = createPerson('DEELNEMER');
    const staff = createPerson('PLANNER');
    const { poolId } = createPool();
    const before = (db.prepare('SELECT COUNT(*) AS c FROM dienstrooster_person').get() as { c: number }).c;

    const res = await addMember(planner.id, poolId, participant.codenaam.toLowerCase());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CODENAAM_HOOFDLETTERS');
    expect(body.error.message).toBe(
      `Er is al iemand met de codenaam "${participant.codenaam}". Bedoel je die persoon, schrijf de codenaam dan precies zo. Anders kies je een andere codenaam.`
    );
    // Nor a participant who looks like a planner's login.
    expect((await addMember(planner.id, poolId, staff.codenaam.toLowerCase())).status).toBe(409);
    expect((db.prepare('SELECT COUNT(*) AS c FROM dienstrooster_person').get() as { c: number }).c).toBe(before);
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

// 0.93.0: the deelnamefactor is no longer typed in. It follows from the
// part-time days the person fills in (lib/deelnamefactor.ts), and the list
// says "nog onbekend" until they handed in their preferences.
describe('the deelnamefactor of a member is not typed in', () => {
  it('adding a member ignores a factor in the request and stores none', async () => {
    const planner = createPerson('PLANNER');
    const participant = createPerson('DEELNEMER');
    const { poolId } = createPool();

    const res = await addMember(planner.id, poolId, participant.codenaam, { deelnamefactor: 0.3 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).not.toHaveProperty('deelnamefactor');
    const rij = db.prepare('SELECT deelnamefactor FROM dienstrooster_pool_membership WHERE person_id = ?').get(participant.id) as {
      deelnamefactor: number;
    };
    expect(rij.deelnamefactor).toBe(1);
  });

  it('changing a member takes dates only: a factor alone is "geen velden"', async () => {
    const planner = createPerson('PLANNER');
    const participant = createPerson('DEELNEMER');
    const { poolId } = createPool();
    const membershipId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, '2027-01-01', '2027-12-31')`
    ).run(membershipId, participant.id, poolId);

    const res = await PATCH(
      new NextRequest(`http://localhost/api/planner/pool/${poolId}/members/${membershipId}`, {
        method: 'PATCH',
        headers: { Cookie: plannerCookie(planner.id), 'Content-Type': 'application/json' },
        body: JSON.stringify({ deelnamefactor: 0.5 }),
      }),
      { params: Promise.resolve({ id: poolId, membershipId }) }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('NO_UPDATES');
    const rij = db.prepare('SELECT deelnamefactor FROM dienstrooster_pool_membership WHERE id = ?').get(membershipId) as { deelnamefactor: number };
    expect(rij.deelnamefactor).toBe(1);
  });

  it('the list shows nog onbekend (null) until the person handed in, then the factor from their part-time days', async () => {
    const planner = createPerson('PLANNER');
    const participant = createPerson('DEELNEMER');
    const { poolId, periodId } = createPool();
    expect((await addMember(planner.id, poolId, participant.codenaam)).status).toBe(201);
    db.prepare(`UPDATE dienstrooster_schedule_period SET uitgenodigd_op = datetime('now') WHERE id = ?`).run(periodId);
    db.prepare(
      `INSERT INTO dienstrooster_parttime_pattern (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, 'MA', 'ELKE_WEEK', '2027-01-01', '2027-12-31', ?, datetime('now'))`
    ).run(crypto.randomUUID(), participant.id, participant.id);

    const lijst = async () => {
      const res = await GET(
        new NextRequest(`http://localhost/api/planner/pool/${poolId}/members`, { headers: { Cookie: plannerCookie(planner.id) } }),
        { params: Promise.resolve({ id: poolId }) }
      );
      return ((await res.json()).data as Array<{ person_id: string; deelnamefactor: number | null }>).find((m) => m.person_id === participant.id)!;
    };
    expect((await lijst()).deelnamefactor).toBeNull();

    db.prepare(
      `INSERT INTO dienstrooster_submission (id, person_id, schedule_period_id, status, ingediend_op, row_version, aangemaakt_op)
       VALUES (?, ?, ?, 'BEVESTIGD', datetime('now'), 1, datetime('now'))`
    ).run(crypto.randomUUID(), participant.id, periodId);
    expect((await lijst()).deelnamefactor).toBe(0.8);
  });
});
