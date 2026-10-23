import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { PATCH } from './route';

/** The rule: only a real true or false switches a pool on or off. The text "false" switched it on. */

const made = { people: [] as string[], pools: [] as string[], rulesets: [] as string[] };

function setup() {
  const ruleset = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`).run(ruleset);
  made.rulesets.push(ruleset);
  const pool = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, actief, aangemaakt_op) VALUES (?, 'Aan uit', ?, 1, datetime('now'))`).run(pool, ruleset);
  made.pools.push(pool);
  const planner = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'PLANNER', 1, datetime('now'))`).run(planner, `Pl-${planner.slice(0, 8)}`);
  made.people.push(planner);
  return { pool, planner };
}

async function zet(w: ReturnType<typeof setup>, body: unknown) {
  const token = createSessionToken(
    { kind: 'staff', personId: w.planner, sessionVersion: getSessionVersion(w.planner)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  const res = await PATCH(
    new NextRequest(`http://localhost/api/planner/pools/${w.pool}`, {
      method: 'PATCH',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: w.pool }) }
  );
  return res.status;
}

const actief = (pool: string) => (db.prepare('SELECT actief FROM dienstrooster_pool WHERE id = ?').get(pool) as { actief: number }).actief;

afterEach(() => {
  for (const id of made.people) db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(id);
  for (const id of made.pools) db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  for (const id of made.rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
  for (const id of made.people) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  made.people = [];
  made.pools = [];
  made.rulesets = [];
});

describe('PATCH /api/planner/pools/[id]', () => {
  it('switches a pool off and on with a real boolean', async () => {
    const w = setup();
    expect(await zet(w, { actief: false })).toBe(200);
    expect(actief(w.pool)).toBe(0);
    expect(await zet(w, { actief: true })).toBe(200);
    expect(actief(w.pool)).toBe(1);
  });

  it.each(['false', 'true', 0, 1, null, {}, []])('refuses %j and changes nothing', async (waarde) => {
    const w = setup();
    expect(await zet(w, { actief: false })).toBe(200);
    expect(await zet(w, { actief: waarde })).toBe(400);
    expect(actief(w.pool)).toBe(0);
  });
});
