import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST } from './route';

/**
 * The rules: a generated or closed period goes back to OPEN; the solver's
 * roster goes with it, while what the planner filled in by hand stays; a
 * published roster is withdrawn first; only a planner can do it.
 */

interface Fixture {
  periodId: string;
  poolId: string;
  rulesetId: string;
  personIds: string[];
  slotIds: string[];
}
const fixtures: Fixture[] = [];

function person(rol: 'PLANNER' | 'DEELNEMER'): string {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`).run(
    id,
    `R-${id.slice(0, 8)}`,
    rol
  );
  return id;
}

function createFixture(status: string): Fixture {
  const rulesetId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'T', '{}', datetime('now'))`).run(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'T', ?, datetime('now'))`).run(poolId, rulesetId);
  const shiftTypeId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`).run(shiftTypeId, poolId);
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'Heropenen', '2027-01-04', '2027-01-10', '2026-12-01T00:00', ?, '{}', datetime('now'))`
  ).run(periodId, poolId, status);
  const slotIds = ['2027-01-04', '2027-01-05'].map((datum) => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week, is_feestdag, benodigd_aantal_personen)
       VALUES (?, ?, ?, ?, 2027, 1, 0, 1)`
    ).run(id, periodId, shiftTypeId, datum);
    return id;
  });
  const f = { periodId, poolId, rulesetId, personIds: [person('PLANNER'), person('DEELNEMER')], slotIds };
  fixtures.push(f);
  return f;
}

function assign(f: Fixture, slotId: string, bron: 'SOLVER' | 'MANUAL') {
  db.prepare(
    `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`
  ).run(crypto.randomUUID(), f.periodId, f.personIds[1], slotId, bron);
}

function reopen(f: Fixture, actorId: string) {
  const token = createSessionToken(
    { kind: 'staff', personId: actorId, sessionVersion: getSessionVersion(actorId)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return POST(
    new NextRequest(`http://localhost/api/periods/${f.periodId}/reopen`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }),
    { params: Promise.resolve({ id: f.periodId }) }
  );
}

const status = (f: Fixture) =>
  (db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(f.periodId) as { status: string }).status;
const bronnen = (f: Fixture) =>
  (db.prepare('SELECT bron FROM dienstrooster_assignment WHERE schedule_version_id = ? ORDER BY bron').all(f.periodId) as Array<{ bron: string }>).map(
    (r) => r.bron
  );

afterEach(() => {
  for (const f of fixtures.splice(0)) {
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_pending_undo WHERE scope_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(f.poolId);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(f.poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(f.rulesetId);
    for (const id of f.personIds) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
});

describe('POST /api/periods/[id]/reopen', () => {
  it('takes a generated period back to OPEN without the solver roster, keeping what was filled in by hand', async () => {
    const f = createFixture('GEGENEREERD');
    assign(f, f.slotIds[0], 'SOLVER');
    assign(f, f.slotIds[1], 'MANUAL');
    const res = await reopen(f, f.personIds[0]);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ status: 'OPEN', verwijderd: 1 });
    expect(status(f)).toBe('OPEN');
    expect(bronnen(f)).toEqual(['MANUAL']);
  });

  it('takes a closed period back to OPEN', async () => {
    const f = createFixture('GESLOTEN');
    expect((await reopen(f, f.personIds[0])).status).toBe(200);
    expect(status(f)).toBe('OPEN');
  });

  it('leaves a published roster alone until it is withdrawn', async () => {
    const f = createFixture('GEPUBLICEERD');
    assign(f, f.slotIds[0], 'SOLVER');
    const res = await reopen(f, f.personIds[0]);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain('publicatie in');
    expect(status(f)).toBe('GEPUBLICEERD');
    expect(bronnen(f)).toEqual(['SOLVER']);
  });

  it('is for planners only', async () => {
    const f = createFixture('GEGENEREERD');
    expect((await reopen(f, f.personIds[1])).status).toBe(401);
    expect(status(f)).toBe('GEGENEREERD');
  });
});
