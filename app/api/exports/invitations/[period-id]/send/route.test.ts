import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, type SmtpSink } from '@/tests/smtpSink';
import { POST } from './route';

/**
 * The rules: the invitations go out as one verzendlijst with a personal link
 * each, only for a planner and an open period; pressed twice at the same
 * time they go out once (and issue one link each), because the check and
 * the note that it was done are both around a network call.
 */

let sink: SmtpSink;
beforeAll(async () => {
  sink = await startSmtpSink();
});
afterAll(async () => {
  await sink.close();
});

const created = { pools: [] as string[], people: [] as string[], periods: [] as string[], rulesets: [] as string[] };

function createPerson(rol: 'DEELNEMER' | 'PLANNER'): string {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`).run(
    id,
    `UI-${id.slice(0, 8)}`,
    rol
  );
  created.people.push(id);
  return id;
}

function createFixture() {
  const rulesetId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`).run(rulesetId);
  created.rulesets.push(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Pool', ?, datetime('now'))`).run(poolId, rulesetId);
  created.pools.push(poolId);
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'Najaar 2099', '2099-03-16', '2099-05-10', '2099-03-11T17:00', 'OPEN', datetime('now'))`
  ).run(periodId, poolId);
  created.periods.push(periodId);
  const members = [0, 1].map(() => {
    const id = createPerson('DEELNEMER');
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, '2020-01-01', '2100-12-31')`
    ).run(crypto.randomUUID(), id, poolId);
    return id;
  });
  return { periodId, planner: createPerson('PLANNER'), members };
}

async function send(periodId: string, asPersonId: string) {
  const token = createSessionToken(
    { kind: 'staff', personId: asPersonId, sessionVersion: getSessionVersion(asPersonId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  const res = await POST(
    new NextRequest(`https://rooster.test/api/exports/invitations/${periodId}/send`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    }),
    { params: Promise.resolve({ 'period-id': periodId }) }
  );
  return { status: res.status, body: await res.json() };
}

const links = (periodId: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').get(periodId) as { n: number }).n;

afterEach(() => {
  clearSmtpConfig();
  sink.received.length = 0;
  for (const id of created.periods) {
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').run(id);
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

describe('POST /api/exports/invitations/[period-id]/send', () => {
  it('sends one invitation per member, with a personal link', async () => {
    configureSmtp(sink);
    const f = createFixture();
    const res = await send(f.periodId, f.planner);
    expect(res.status).toBe(200);
    const lijst = verzendlijstPayload(sink.received[0].raw);
    expect(lijst.soort).toBe('UITNODIGING');
    expect(lijst.berichten).toHaveLength(2);
    expect(links(f.periodId)).toBe(2);
  });

  it('sends once, and issues one link each, when pressed twice at the same time', async () => {
    configureSmtp(sink);
    const f = createFixture();
    const [a, b] = await Promise.all([send(f.periodId, f.planner), send(f.periodId, f.planner)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.error.code).toBe('BEZIG');
    expect(sink.received).toHaveLength(1);
    expect(links(f.periodId)).toBe(2);
  });
});
