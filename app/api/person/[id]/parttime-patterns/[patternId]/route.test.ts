import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { syncAvailabilityForPattern } from '@/lib/parttimeSync';
import { DELETE } from './route';

/**
 * The hard rule: deleting a part-time pattern only ever touches your own.
 *
 * The route released the pattern's availability rows first and only then
 * ran the (correctly person-scoped) DELETE - which found nothing for
 * someone else's pattern id, but the transaction still committed the
 * release. Anyone with a session and another person's pattern id could
 * strip that person's part-time blocks out of every period still open for
 * input, while getting a 404 back as if nothing had happened.
 */

const created = { pools: [] as string[], people: [] as string[] };

function createParticipant(poolId: string): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
  ).run(id, `PT-${id.slice(0, 8)}`);
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), id, hashToken(`l-${crypto.randomUUID()}`));
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
  ).run(crypto.randomUUID(), id, poolId);
  created.people.push(id);
  return id;
}

function createFixture() {
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
     VALUES (?, ?, 'P', '2027-01-04', '2027-01-10', '2099-01-01T00:00', 'OPEN', datetime('now'))`
  ).run(periodId, poolId);
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
     VALUES (?, ?, ?, '2027-01-04', 2027, 1)`
  ).run(crypto.randomUUID(), periodId, shiftTypeId);

  const attacker = createParticipant(poolId);
  const victim = createParticipant(poolId);
  const patternId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_parttime_pattern
       (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
     VALUES (?, ?, 'MA', 'ELKE_WEEK', '2020-01-01', '2030-12-31', ?, datetime('now'))`
  ).run(patternId, victim, victim);
  syncAvailabilityForPattern(patternId);
  return { attacker, victim, patternId };
}

function del(personId: string, patternId: string) {
  const token = createSessionToken(
    { kind: 'person', personId, sessionVersion: getSessionVersion(personId)! },
    PERSON_SESSION_MAX_AGE_SECONDS
  );
  return DELETE(
    new NextRequest(`http://localhost/api/person/${personId}/parttime-patterns/${patternId}`, {
      method: 'DELETE',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }),
    { params: Promise.resolve({ id: personId, patternId }) }
  );
}

function blocksOf(personId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM dienstrooster_availability WHERE person_id = ? AND source = 'PARTTIME'`).get(
      personId
    ) as { c: number }
  ).c;
}

afterEach(() => {
  for (const personId of created.people) {
    db.prepare('DELETE FROM dienstrooster_availability WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_parttime_pattern WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_submission WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
  for (const poolId of created.pools) {
    for (const { id } of db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?').all(poolId) as Array<{
      id: string;
    }>) {
      db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as { ruleset_id: string };
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  created.people = [];
  created.pools = [];
});

describe('DELETE /api/person/[id]/parttime-patterns/[patternId]', () => {
  it("leaves someone else's pattern and its blocks untouched", async () => {
    const f = createFixture();
    expect(blocksOf(f.victim)).toBe(1);

    const res = await del(f.attacker, f.patternId);
    expect(res.status).toBe(404);
    expect(blocksOf(f.victim)).toBe(1);
  });

  it('deletes your own pattern and its blocks in an open period', async () => {
    const f = createFixture();
    const res = await del(f.victim, f.patternId);
    expect(res.status).toBe(200);
    expect(blocksOf(f.victim)).toBe(0);
  });
});
