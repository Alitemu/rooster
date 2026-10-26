import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { PATCH, DELETE } from './route';

/**
 * A membership change that reaches a period whose roster exists asks for
 * confirmation first (lib/membershipRooster.ts): the roster does not change
 * with it. Changes that stay clear of such periods go through as before.
 */

const made = { pools: [] as string[], rulesets: [] as string[], people: [] as string[], periods: [] as string[] };

function setup(status: string) {
  const ruleset = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`).run(ruleset);
  made.rulesets.push(ruleset);
  const pool = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'P', ?, datetime('now'))`).run(pool, ruleset);
  made.pools.push(pool);
  const person = (rol: string) => {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`).run(id, `Rooster-${id.slice(0, 8)}`, rol);
    made.people.push(id);
    return id;
  };
  const planner = person('PLANNER');
  const lid = person('DEELNEMER');
  const membership = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, 1, '2040-01-01', '2040-12-31')`
  ).run(membership, lid, pool);
  const period = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'Zomer 2040', '2040-07-02', '2040-07-29', '2039-01-01T00:00', ?, datetime('now'))`
  ).run(period, pool, status);
  made.periods.push(period);
  return { pool, planner, lid, membership, period };
}

function stuur(method: 'PATCH' | 'DELETE', w: ReturnType<typeof setup>, body?: unknown, query = '') {
  const token = createSessionToken(
    { kind: 'staff', personId: w.planner, sessionVersion: getSessionVersion(w.planner)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  const req = new NextRequest(`http://localhost/api/planner/pool/${w.pool}/members/${w.membership}${query}`, {
    method,
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const props = { params: Promise.resolve({ id: w.pool, membershipId: w.membership }) };
  return method === 'PATCH' ? PATCH(req, props) : DELETE(req, props);
}

const bestaat = (w: ReturnType<typeof setup>) =>
  Boolean(db.prepare('SELECT 1 FROM dienstrooster_pool_membership WHERE id = ?').get(w.membership));
const datums = (w: ReturnType<typeof setup>) =>
  db.prepare('SELECT geldig_vanaf, geldig_tot FROM dienstrooster_pool_membership WHERE id = ?').get(w.membership);

afterEach(() => {
  for (const id of made.periods.splice(0)) db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
  for (const id of made.pools) {
    db.prepare('DELETE FROM dienstrooster_pending_undo WHERE scope_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  }
  made.pools = [];
  for (const id of made.rulesets.splice(0)) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
  for (const id of made.people) db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(id);
  for (const id of made.people.splice(0)) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
});

describe('a membership change that reaches a period with a roster', () => {
  it.each(['GEGENEREERD', 'GEPUBLICEERD'])('asks for confirmation (409) when the end moves into a %s period', async (status) => {
    const w = setup(status);
    const res = await stuur('PATCH', w, { geldig_tot: '2040-07-15' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('LIDMAATSCHAP_RAAKT_ROOSTER');
    expect(body.error.message).toContain('Zomer 2040');
    expect(datums(w)).toEqual({ geldig_vanaf: '2040-01-01', geldig_tot: '2040-12-31' });
  });

  it('goes through once it is confirmed', async () => {
    const w = setup('GEPUBLICEERD');
    expect((await stuur('PATCH', w, { geldig_tot: '2040-07-15', bevestigd: true })).status).toBe(200);
    expect(datums(w)).toEqual({ geldig_vanaf: '2040-01-01', geldig_tot: '2040-07-15' });
  });

  it('does not ask when the days that change lie outside such periods', async () => {
    const w = setup('GEPUBLICEERD');
    // The membership covers the period before and after; only the autumn moves.
    expect((await stuur('PATCH', w, { geldig_tot: '2040-10-31' })).status).toBe(200);
  });

  it('does not ask for a period without a roster yet or one in the prullenbak', async () => {
    const open = setup('OPEN');
    expect((await stuur('PATCH', open, { geldig_tot: '2040-07-15' })).status).toBe(200);
    const weg = setup('GEPUBLICEERD');
    db.prepare(`UPDATE dienstrooster_schedule_period SET verwijderd_op = datetime('now') WHERE id = ?`).run(weg.period);
    expect((await stuur('PATCH', weg, { geldig_tot: '2040-07-15' })).status).toBe(200);
  });

  it('asks before removing the membership, and removes it with ?bevestigd=1', async () => {
    const w = setup('GEGENEREERD');
    const res = await stuur('DELETE', w);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('LIDMAATSCHAP_RAAKT_ROOSTER');
    expect(bestaat(w)).toBe(true);
    expect((await stuur('DELETE', w, undefined, '?bevestigd=1')).status).toBe(200);
    expect(bestaat(w)).toBe(false);
  });

  it('only a literal true counts as confirmed', async () => {
    const w = setup('GEPUBLICEERD');
    expect((await stuur('PATCH', w, { geldig_tot: '2040-07-15', bevestigd: 'ja' })).status).toBe(409);
  });
});
