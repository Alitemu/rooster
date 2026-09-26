import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { setParttimeCheck } from '@/lib/submissionStatus';
import { POST } from './route';

/**
 * The hard rules: handing in needs the "Deeltijd" check on record - the
 * server's own record, whatever the client says - and then works for
 * someone who changed nothing else first.
 *
 * Someone who opens their link, checks their part-time days and just
 * confirms has no row until that check writes one; the INSERT for that
 * case once left out the NOT NULL aangemaakt_op, so "Indienen" failed with
 * a bare "Er is iets misgegaan" for exactly the people with nothing to
 * change.
 */

const created = { pools: [] as string[], people: [] as string[] };

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
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'P', '2027-01-04', '2027-01-10', '2099-01-01T00:00', 'OPEN', datetime('now'))`
  ).run(periodId, poolId);
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
  ).run(personId, `SUB-${personId.slice(0, 8)}`);
  created.people.push(personId);
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, hashToken(`l-${crypto.randomUUID()}`));
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
  ).run(crypto.randomUUID(), personId, poolId);
  return { personId, periodId };
}

afterEach(() => {
  for (const personId of created.people) {
    db.prepare('DELETE FROM dienstrooster_submission WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
  for (const poolId of created.pools) {
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as { ruleset_id: string };
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  created.people = [];
  created.pools = [];
});

function submit(personId: string, periodId: string) {
  const token = createSessionToken(
    { kind: 'person', personId, sessionVersion: getSessionVersion(personId)! },
    PERSON_SESSION_MAX_AGE_SECONDS
  );
  return POST(
    new NextRequest(`http://localhost/api/person/${personId}/preferences/submission`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
      // parttime_confirmed is what older clients sent; it no longer counts.
      body: JSON.stringify({ period_id: periodId, parttime_confirmed: true }),
    }),
    { params: Promise.resolve({ id: personId }) }
  );
}

const statusOf = (personId: string, periodId: string) =>
  (
    db
      .prepare('SELECT status FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?')
      .get(personId, periodId) as { status: string } | undefined
  )?.status;

describe('POST /api/person/[id]/preferences/submission', () => {
  it('confirms once the part-time check is on record, for someone who changed nothing else', async () => {
    const { personId, periodId } = createFixture();
    setParttimeCheck(personId, periodId, true);

    const res = await submit(personId, periodId);

    expect(res.status).toBe(200);
    expect(statusOf(personId, periodId)).toBe('BEVESTIGD');
  });

  it('refuses without the part-time check on record, whatever the client sends', async () => {
    const { personId, periodId } = createFixture();

    const res = await submit(personId, periodId);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('PARTTIME_NOT_CONFIRMED');
    expect(statusOf(personId, periodId)).toBeUndefined();
  });
});
