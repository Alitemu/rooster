import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST } from './route';

/**
 * The rule: a beginsaldo file sent twice (a lost response, a second click)
 * counts once. The imported beginsaldo of a person is replaced by what the
 * file says; a correction made by hand is another category and stays; a
 * person who is not in the file keeps theirs.
 */

const made = { people: [] as string[], pools: [] as string[], rulesets: [] as string[], periods: [] as string[] };

function person(rol: 'DEELNEMER' | 'PLANNER') {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`).run(id, `Bs-${id.slice(0, 8)}`, rol);
  made.people.push(id);
  return { id, codenaam: `Bs-${id.slice(0, 8)}` };
}

function setup() {
  const now = new Date().toISOString();
  const ruleset = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', ?)`).run(ruleset, now);
  made.rulesets.push(ruleset);
  const pool = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Beginsaldo', ?, ?)`).run(pool, ruleset, now);
  made.pools.push(pool);
  const period = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'Beginsaldo', '2099-03-16', '2099-05-10', '2099-03-01T17:00', 'CONCEPT', ?)`
  ).run(period, pool, now);
  made.periods.push(period);
  const members = [person('DEELNEMER'), person('DEELNEMER')];
  for (const m of members) {
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, 1, '2020-01-01', '2100-12-31')`
    ).run(crypto.randomUUID(), m.id, pool);
  }
  return { pool, period, members, planner: person('PLANNER').id };
}

async function importeer(w: ReturnType<typeof setup>, rows: unknown[]) {
  const token = createSessionToken(
    { kind: 'staff', personId: w.planner, sessionVersion: getSessionVersion(w.planner)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  const res = await POST(
    new NextRequest(`http://localhost/api/planner/period/${w.period}/import-balances`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    }),
    { params: Promise.resolve({ id: w.period }) }
  );
  return { status: res.status, body: await res.json() };
}

const saldo = (w: ReturnType<typeof setup>, personId: string, teller: string) =>
  (
    db
      .prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM dienstrooster_ledger_entry WHERE person_id = ? AND geldt_voor_periode_id = ? AND teller = ?')
      .get(personId, w.period, teller) as { s: number }
  ).s;

afterEach(() => {
  for (const id of made.periods) {
    db.prepare('DELETE FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
  }
  for (const id of made.people) db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(id);
  for (const id of made.pools) {
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  }
  for (const id of made.rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
  for (const id of made.people) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  made.people = [];
  made.pools = [];
  made.rulesets = [];
  made.periods = [];
});

describe('POST /api/planner/period/[id]/import-balances', () => {
  it('counts a file sent twice once', async () => {
    const w = setup();
    const [a] = w.members;
    const rows = [{ codenaam: a.codenaam, AVOND_delta: 2, WEEKEND_delta: -1 }];
    expect((await importeer(w, rows)).status).toBe(200);
    expect((await importeer(w, rows)).status).toBe(200);
    expect(saldo(w, a.id, 'AVOND')).toBe(2);
    expect(saldo(w, a.id, 'WEEKEND')).toBe(-1);
  });

  it('replaces the earlier import of a person with what the new file says, zero included', async () => {
    const w = setup();
    const [a] = w.members;
    await importeer(w, [{ codenaam: a.codenaam, AVOND_delta: 2, WEEKEND_delta: -1 }]);
    await importeer(w, [{ codenaam: a.codenaam, AVOND_delta: 5 }]);
    expect(saldo(w, a.id, 'AVOND')).toBe(5);
    expect(saldo(w, a.id, 'WEEKEND')).toBe(0);
  });

  it('leaves the beginsaldo of somebody who is not in the file, and a correction made by hand', async () => {
    const w = setup();
    const [a, b] = w.members;
    await importeer(w, [{ codenaam: a.codenaam, AVOND_delta: 1 }, { codenaam: b.codenaam, AVOND_delta: 3 }]);
    db.prepare(
      `INSERT INTO dienstrooster_ledger_entry (id, person_id, pool_id, teller, geldt_voor_periode_id, delta, reden, categorie, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, 'AVOND', ?, 4, 'Handmatig', 'CORRECTIE', ?, datetime('now'))`
    ).run(crypto.randomUUID(), a.id, w.pool, w.period, w.planner);
    await importeer(w, [{ codenaam: a.codenaam, AVOND_delta: 2 }]);
    expect(saldo(w, a.id, 'AVOND')).toBe(2 + 4);
    expect(saldo(w, b.id, 'AVOND')).toBe(3);
  });

  it('still adds up two rows of one person in the same file', async () => {
    const w = setup();
    const [a] = w.members;
    const res = await importeer(w, [{ codenaam: a.codenaam, AVOND_delta: 1 }, { codenaam: a.codenaam, AVOND_delta: 2 }]);
    expect(res.status).toBe(200);
    expect(saldo(w, a.id, 'AVOND')).toBe(3);
  });
});
