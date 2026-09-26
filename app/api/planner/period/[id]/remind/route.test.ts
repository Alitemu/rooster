import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, type SmtpSink } from '@/tests/smtpSink';
import { POST } from './route';

/**
 * The rules:
 * - one person, or everyone who hasn't handed in, gets the standard
 *   reminder with a personal link; someone who handed in never does.
 * - only while the period is open for preferences, only for a planner.
 * - it is logged, so the automatic reminder leaves these people alone.
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
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(id, `HR-${id.slice(0, 8)}`, rol);
  created.people.push(id);
  return id;
}

function createFixture(status = 'OPEN') {
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
     VALUES (?, ?, 'Voorjaar 2099', '2099-03-16', '2099-05-10', '2099-03-11T17:00', ?, datetime('now'))`
  ).run(periodId, poolId, status);
  created.periods.push(periodId);

  const member = (submission: 'BEZIG' | 'BEVESTIGD' | null) => {
    const id = createPerson('DEELNEMER');
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, '2020-01-01', '2100-12-31')`
    ).run(crypto.randomUUID(), id, poolId);
    if (submission) {
      db.prepare(
        `INSERT INTO dienstrooster_submission (id, person_id, schedule_period_id, status, aangemaakt_op)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(crypto.randomUUID(), id, periodId, submission);
    }
    return id;
  };

  return {
    periodId,
    planner: createPerson('PLANNER'),
    nietBegonnen: member(null),
    bezig: member('BEZIG'),
    ingediend: member('BEVESTIGD'),
  };
}

function codenaam(id: string): string {
  return (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(id) as { codenaam: string }).codenaam;
}

async function remind(periodId: string, asPersonId: string, body: object = {}) {
  const token = createSessionToken(
    { kind: 'staff', personId: asPersonId, sessionVersion: getSessionVersion(asPersonId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  const res = await POST(
    new NextRequest(`https://rooster.test/api/planner/period/${periodId}/remind`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: periodId }) }
  );
  return { status: res.status, body: await res.json() };
}

function remindersLogged(periodId: string): string[] {
  return (
    db
      .prepare(`SELECT person_id FROM dienstrooster_notification_log WHERE period_id = ? AND type = 'REMINDER'`)
      .all(periodId) as Array<{ person_id: string }>
  ).map((r) => r.person_id);
}

afterEach(() => {
  clearSmtpConfig();
  sink.received.length = 0;
  for (const id of created.periods) {
    db.prepare('DELETE FROM dienstrooster_notification_log WHERE period_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_submission WHERE schedule_period_id = ?').run(id);
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

describe('POST /api/planner/period/[id]/remind', () => {
  it('reminds one person, with a personal link', async () => {
    configureSmtp(sink);
    const f = createFixture();

    const res = await remind(f.periodId, f.planner, { person_id: f.bezig });

    expect(res.status).toBe(200);
    expect(res.body.data.aantal).toBe(1);
    const lijst = verzendlijstPayload(sink.received[0].raw);
    expect(lijst.soort).toBe('HERINNERING');
    expect(lijst.automatisch).toBe(false);
    expect(lijst.berichten.map((b) => b.codenaam)).toEqual([codenaam(f.bezig)]);
    expect(lijst.berichten[0].tekst).toContain('nog niet ingediend');
    expect(lijst.berichten[0].tekst).toMatch(/\/person\/[0-9a-f]{64}/);
    expect(remindersLogged(f.periodId)).toEqual([f.bezig]);
  });

  it('reminds everyone who has not handed in, and nobody who has', async () => {
    configureSmtp(sink);
    const f = createFixture();

    const res = await remind(f.periodId, f.planner);

    expect(res.status).toBe(200);
    const lijst = verzendlijstPayload(sink.received[0].raw);
    expect(lijst.berichten.map((b) => b.codenaam).sort()).toEqual([codenaam(f.nietBegonnen), codenaam(f.bezig)].sort());
    expect(lijst.nog_niets_ingevuld).toBe(1);
    expect(lijst.nog_niet_ingediend).toBe(1);
    expect(remindersLogged(f.periodId).sort()).toEqual([f.nietBegonnen, f.bezig].sort());
  });

  it('refuses a reminder to someone who has handed in', async () => {
    configureSmtp(sink);
    const f = createFixture();

    const res = await remind(f.periodId, f.planner, { person_id: f.ingediend });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SUBMITTED');
    expect(sink.received).toHaveLength(0);
  });

  it('sends nothing once the period is closed', async () => {
    configureSmtp(sink);
    const f = createFixture('GESLOTEN');

    const res = await remind(f.periodId, f.planner);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PERIOD_NOT_OPEN');
    expect(sink.received).toHaveLength(0);
  });

  it('says so when sending is not set up', async () => {
    const f = createFixture();

    const res = await remind(f.periodId, f.planner);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
  });

  it('is refused to a participant', async () => {
    configureSmtp(sink);
    const f = createFixture();

    const res = await remind(f.periodId, f.bezig);

    expect(res.status).toBe(401);
    expect(sink.received).toHaveLength(0);
  });
});
