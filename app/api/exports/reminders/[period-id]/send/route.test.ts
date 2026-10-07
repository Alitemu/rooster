import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, type SmtpSink } from '@/tests/smtpSink';
import { POST } from './route';

/**
 * The rule: the export dialog's reminders go out as one verzendlijst and
 * are logged, but not while one of the recipients got a reminder in the
 * last 24 hours, unless the planner said `opnieuw` (the same rule as
 * "Status voorkeuren").
 */

let sink: SmtpSink;
beforeAll(async () => {
  sink = await startSmtpSink();
});
afterAll(async () => {
  await sink.close();
});

const created = { pools: [] as string[], people: [] as string[], periods: [] as string[], rulesets: [] as string[] };
const DEADLINE = '2099-03-11T17:00';

function createPerson(rol: 'DEELNEMER' | 'PLANNER'): { id: string; codenaam: string } {
  const id = crypto.randomUUID();
  const codenaam = `ER-${id.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(id, codenaam, rol);
  created.people.push(id);
  return { id, codenaam };
}

function createFixture() {
  const rulesetId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`).run(
    rulesetId
  );
  created.rulesets.push(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Pool', ?, datetime('now'))`).run(
    poolId,
    rulesetId
  );
  created.pools.push(poolId);
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'Voorjaar 2099', '2099-03-16', '2099-05-10', ?, 'OPEN', datetime('now'))`
  ).run(periodId, poolId, DEADLINE);
  created.periods.push(periodId);
  const member = () => {
    const p = createPerson('DEELNEMER');
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, '2020-01-01', '2100-12-31')`
    ).run(crypto.randomUUID(), p.id, poolId);
    return p;
  };
  return { periodId, planner: createPerson('PLANNER').id, a: member(), b: member() };
}

function remindedAgo(periodId: string, personId: string, hours: number) {
  const op = new Date(Date.now() - hours * 3600_000).toISOString();
  db.prepare(
    `INSERT INTO dienstrooster_notification_log (id, person_id, period_id, type, opgesteld_op, gemaild_op)
     VALUES (?, ?, ?, 'REMINDER', ?, ?)`
  ).run(crypto.randomUUID(), personId, periodId, op, op);
  return op;
}

async function send(periodId: string, asPersonId: string, codenamen: string[], opnieuw?: boolean) {
  const token = createSessionToken(
    { kind: 'staff', personId: asPersonId, sessionVersion: getSessionVersion(asPersonId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  const res = await POST(
    new NextRequest(`https://rooster.test/api/exports/reminders/${periodId}/send`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deadline: DEADLINE,
        berichten: codenamen.map((codenaam) => ({ codenaam, onderwerp: 'Herinnering', tekst: `Beste ${codenaam},` })),
        ...(opnieuw === undefined ? {} : { opnieuw }),
      }),
    }),
    { params: Promise.resolve({ 'period-id': periodId }) }
  );
  return { status: res.status, body: await res.json() };
}

const logged = (periodId: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_notification_log WHERE period_id = ?').get(periodId) as { n: number }).n;

afterEach(() => {
  clearSmtpConfig();
  sink.received.length = 0;
  for (const id of created.periods) {
    db.prepare('DELETE FROM dienstrooster_notification_log WHERE period_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
  }
  for (const id of created.pools) {
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  }
  for (const id of created.rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
  for (const id of created.people) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  created.pools = [];
  created.people = [];
  created.periods = [];
  created.rulesets = [];
});

describe('POST /api/exports/reminders/[period-id]/send', () => {
  it('sends the reminders as one verzendlijst and logs them', async () => {
    configureSmtp(sink);
    const f = createFixture();
    const res = await send(f.periodId, f.planner, [f.a.codenaam, f.b.codenaam]);
    expect(res.status).toBe(200);
    expect(verzendlijstPayload(sink.received[0].raw).berichten.map((b) => b.codenaam).sort()).toEqual(
      [f.a.codenaam, f.b.codenaam].sort()
    );
    expect(logged(f.periodId)).toBe(2);
  });

  it('sends nothing while one of them was reminded in the last 24 hours, and says who', async () => {
    configureSmtp(sink);
    const f = createFixture();
    const op = remindedAgo(f.periodId, f.b.id, 3);

    const res = await send(f.periodId, f.planner, [f.a.codenaam, f.b.codenaam]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RECENT_HERINNERD');
    expect(res.body.error.recent).toEqual([{ codenaam: f.b.codenaam, laatste_herinnering_op: op }]);
    expect(sink.received).toHaveLength(0);
    expect(logged(f.periodId)).toBe(1);
  });

  it('sends anyway when told to', async () => {
    configureSmtp(sink);
    const f = createFixture();
    remindedAgo(f.periodId, f.b.id, 3);

    expect((await send(f.periodId, f.planner, [f.a.codenaam, f.b.codenaam], true)).status).toBe(200);
    expect(sink.received).toHaveLength(1);
  });

  it('a reminder more than 24 hours ago does not count', async () => {
    configureSmtp(sink);
    const f = createFixture();
    remindedAgo(f.periodId, f.a.id, 25);

    expect((await send(f.periodId, f.planner, [f.a.codenaam])).status).toBe(200);
  });

  it('is refused to a participant', async () => {
    configureSmtp(sink);
    const f = createFixture();
    expect((await send(f.periodId, f.a.id, [f.a.codenaam])).status).toBe(401);
    expect(sink.received).toHaveLength(0);
  });
});
