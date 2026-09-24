import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { deleteMailSettings, saveMailSettings } from '@/lib/appSettings';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { runAutoReminders, reminderMoment } from '@/lib/autoReminders';
import { GET, PATCH } from './route';

/**
 * The rule: a planner can pause automatic reminders for one period, and a
 * paused period gets none; nobody else can switch them.
 */

const created = { periods: [] as string[], pools: [] as string[], people: [] as string[] };

function fixture() {
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
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'P', '2099-03-16', '2099-05-10', '2099-03-11T17:00', 'OPEN', datetime('now'))`
  ).run(periodId, poolId);
  created.periods.push(periodId);
  const planner = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'PLANNER', 1, datetime('now'))`
  ).run(planner, `AR-${planner.slice(0, 8)}`);
  created.people.push(planner);
  return { periodId, planner };
}

function request(method: 'GET' | 'PATCH', periodId: string, plannerId: string | null, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (plannerId) {
    const token = createSessionToken(
      { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! } as never,
      STAFF_SESSION_MAX_AGE_SECONDS
    );
    headers.Cookie = `${SESSION_COOKIE_NAME}=${token}`;
  }
  return new NextRequest(`http://localhost/api/planner/period/${periodId}/auto-reminders`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => {
  for (const id of created.periods) {
    db.prepare('DELETE FROM dienstrooster_reminder_run WHERE period_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
  }
  for (const poolId of created.pools) {
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as { ruleset_id: string };
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  for (const id of created.people) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  created.periods = [];
  created.pools = [];
  created.people = [];
  deleteMailSettings();
});

describe('/api/planner/period/[id]/auto-reminders', () => {
  it('pauses a period, and a paused period claims no reminder moment', async () => {
    const f = fixture();
    const res = await PATCH(request('PATCH', f.periodId, f.planner, { aan: false }), {
      params: Promise.resolve({ id: f.periodId }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.aan).toBe(false);

    // Mail "configured" (never actually reached: nothing is due for a paused period).
    saveMailSettings({ gebruiker: 'x@gmail.com', wachtwoord: 'y', verzendlijstAan: 'z@example.test' }, null);
    await runAutoReminders(reminderMoment(new Date('2099-03-11T17:00'), 7), { onlyPeriodIds: [f.periodId] });
    const runs = db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_reminder_run WHERE period_id = ?').get(f.periodId) as {
      n: number;
    };
    expect(runs.n).toBe(0);

    const back = await PATCH(request('PATCH', f.periodId, f.planner, { aan: true }), {
      params: Promise.resolve({ id: f.periodId }),
    });
    expect((await back.json()).data.aan).toBe(true);
  });

  it('refuses anyone who is not a planner', async () => {
    const f = fixture();
    const res = await PATCH(request('PATCH', f.periodId, null, { aan: false }), {
      params: Promise.resolve({ id: f.periodId }),
    });
    expect(res.status).toBe(401);
    const get = await GET(request('GET', f.periodId, null), { params: Promise.resolve({ id: f.periodId }) });
    expect(get.status).toBe(401);
  });

  it('refuses a request that does not say on or off', async () => {
    const f = fixture();
    const res = await PATCH(request('PATCH', f.periodId, f.planner, { aan: 'ja' }), {
      params: Promise.resolve({ id: f.periodId }),
    });
    expect(res.status).toBe(400);
  });
});
