import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET, PUT } from './route';
import { POST as postAbsence } from '../absences/route';
import { POST as postPattern } from '../parttime-patterns/route';

/**
 * The rules: the part-time check is stored per person per period, so it
 * holds wherever the participant comes back; any new absence or part-time
 * pattern clears it, because the blocked days it vouched for changed; and
 * it can only be set while the period still takes input.
 */

const created = { pools: [] as string[], people: [] as string[], rulesets: [] as string[] };

function createFixture(deadline = '2099-01-01T17:00') {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`
  ).run(rulesetId);
  created.rulesets.push(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Pool', ?, datetime('now'))`
  ).run(poolId, rulesetId);
  created.pools.push(poolId);
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'P', '2099-03-02', '2099-03-29', ?, 'OPEN', datetime('now'))`
  ).run(periodId, poolId, deadline);
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
  ).run(personId, `DC-${personId.slice(0, 8)}`);
  created.people.push(personId);
  // A participant's session is only valid while they hold a link.
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, hashToken(`l-${crypto.randomUUID()}`));
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, '2020-01-01', '2100-12-31')`
  ).run(crypto.randomUUID(), personId, poolId);
  return { personId, periodId };
}

function request(personId: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const token = createSessionToken(
    { kind: 'person', personId, sessionVersion: getSessionVersion(personId)! },
    PERSON_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost/api/person/${personId}${path}`, {
    method: init.method ?? 'GET',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function isChecked(personId: string, periodId: string): Promise<boolean> {
  const res = await GET(request(personId, `/parttime-check?period_id=${periodId}`), params(personId));
  expect(res.status).toBe(200);
  return (await res.json()).data.gecontroleerd;
}

async function check(personId: string, periodId: string, gecontroleerd: boolean) {
  return PUT(
    request(personId, '/parttime-check', { method: 'PUT', body: { period_id: periodId, gecontroleerd } }),
    params(personId)
  );
}

afterEach(() => {
  for (const personId of created.people) {
    db.prepare('DELETE FROM dienstrooster_availability WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_absence WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_parttime_pattern WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_submission WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
  for (const poolId of created.pools) {
    db.prepare(
      'DELETE FROM dienstrooster_shift_slot WHERE period_id IN (SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?)'
    ).run(poolId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE pool_id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
  }
  for (const id of created.rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
  created.pools = [];
  created.people = [];
  created.rulesets = [];
});

describe('/api/person/[id]/parttime-check', () => {
  it('is stored, read back and can be taken back', async () => {
    const { personId, periodId } = createFixture();
    expect(await isChecked(personId, periodId)).toBe(false);

    expect((await check(personId, periodId, true)).status).toBe(200);
    expect(await isChecked(personId, periodId)).toBe(true);

    await check(personId, periodId, false);
    expect(await isChecked(personId, periodId)).toBe(false);
  });

  it('lapses when an absence is added', async () => {
    const { personId, periodId } = createFixture();
    await check(personId, periodId, true);

    const res = await postAbsence(
      request(personId, '/absences', {
        method: 'POST',
        body: { van_datum: '2099-03-09', tot_datum: '2099-03-13', soort: 'VAKANTIE' },
      }),
      params(personId)
    );
    expect(res.status).toBe(201);

    expect(await isChecked(personId, periodId)).toBe(false);
  });

  it('lapses when a part-time pattern is added', async () => {
    const { personId, periodId } = createFixture();
    await check(personId, periodId, true);

    const res = await postPattern(
      request(personId, '/parttime-patterns', {
        method: 'POST',
        body: { weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2099-03-02', geldig_tot: '2099-03-29' },
      }),
      params(personId)
    );
    expect(res.status).toBeLessThan(300);

    expect(await isChecked(personId, periodId)).toBe(false);
  });

  it('cannot be set once the deadline has passed', async () => {
    const { personId, periodId } = createFixture('2020-01-01T17:00');

    expect((await check(personId, periodId, true)).status).toBe(403);
    expect(await isChecked(personId, periodId)).toBe(false);
  });

  it('is nobody else’s to read or set', async () => {
    const mine = createFixture();
    const other = createFixture();

    const res = await PUT(
      request(other.personId, `/parttime-check`, { method: 'PUT', body: { period_id: mine.periodId, gecontroleerd: true } }),
      params(mine.personId)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await isChecked(mine.personId, mine.periodId)).toBe(false);
  });
});
