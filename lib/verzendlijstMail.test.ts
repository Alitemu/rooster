import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { VERZENDLIJST_SUBJECT } from './verzendlijst';
import {
  startSmtpSink,
  configureSmtp,
  clearSmtpConfig,
  verzendlijstAttachment as attachment,
  verzendlijstPayload,
  type SmtpSink,
} from '@/tests/smtpSink';
import { POST as sendInvitations } from '@/app/api/exports/invitations/[period-id]/send/route';
import { POST as sendReminders } from '@/app/api/exports/reminders/[period-id]/send/route';

/**
 * The rules:
 * - the verzendlijst reaches the configured mailbox as one mail with the
 *   fixed subject the Power Automate flow filters on, and a JSON
 *   attachment holding every participant's own working link.
 * - it only ever goes to VERZENDLIJST_AAN, never to an address from the
 *   request.
 * - nothing is issued or sent when the server isn't set up for it, and a
 *   codenaam that doesn't take part in the period is refused before
 *   sending (the flow would otherwise fail on it out of sight).
 *
 * A real SMTP server on localhost receives the mail - no mocked transport.
 */

let sink: SmtpSink;

beforeAll(async () => {
  sink = await startSmtpSink();
});

afterAll(async () => {
  await sink.close();
});

const configure = (overrides: Parameters<typeof configureSmtp>[1] = {}) => configureSmtp(sink, overrides);

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
     VALUES (?, ?, 'Voorjaar 2099', '2099-03-02', '2099-04-26', '2099-02-01T17:00', 'OPEN', datetime('now'))`
  ).run(periodId, poolId);

  const person = (rol: string, membership: [string, string] | null) => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
    ).run(id, `VL-${id.slice(0, 8)}`, rol);
    if (membership) {
      db.prepare(
        `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
         VALUES (?, ?, ?, ?, ?)`
      ).run(crypto.randomUUID(), id, poolId, membership[0], membership[1]);
    }
    created.people.push(id);
    return id;
  };

  const planner = person('PLANNER', null);
  const a = person('DEELNEMER', ['2020-01-01', '2100-12-31']);
  const b = person('DEELNEMER', ['2020-01-01', '2100-12-31']);
  // Membership ended before this period: not invited.
  const gone = person('DEELNEMER', ['2020-01-01', '2098-12-31']);
  return { periodId, planner, a, b, gone };
}

function codenaam(id: string): string {
  return (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(id) as { codenaam: string }).codenaam;
}

function linkCount(personId: string, periodId: string): number {
  return (
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM dienstrooster_person_access_link WHERE person_id = ? AND geldt_voor_periode_id = ?'
      )
      .get(personId, periodId) as { n: number }
  ).n;
}

function plannerRequest(url: string, plannerId: string, body?: unknown): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE_NAME}=${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new NextRequest(url, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

afterEach(() => {
  clearSmtpConfig();
  sink.received.length = 0;
  for (const poolId of created.pools) {
    for (const { id } of db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?').all(poolId) as Array<{
      id: string;
    }>) {
      db.prepare('DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_notification_log WHERE period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as { ruleset_id: string };
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  for (const id of created.people) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  created.pools = [];
  created.people = [];
});

describe('verzendlijst over SMTP', () => {
  it('mails the invitations to the flow mailbox, each with its own working link', async () => {
    configure();
    const f = createFixture();
    const res = await sendInvitations(
      plannerRequest(`http://localhost/api/exports/invitations/${f.periodId}/send`, f.planner),
      { params: Promise.resolve({ 'period-id': f.periodId }) }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.aantal).toBe(2);

    expect(sink.received).toHaveLength(1);
    const [mail] = sink.received;
    expect(mail.to).toEqual(['stroom@example.test']);
    expect(mail.from).toBe('rooster@example.test');
    expect(mail.raw).toMatch(new RegExp(`^Subject: ${VERZENDLIJST_SUBJECT}\\r?$`, 'm'));

    const berichten = attachment(mail.raw);
    expect(berichten.map((b) => b.codenaam).sort()).toEqual([codenaam(f.a), codenaam(f.b)].sort());
    for (const bericht of berichten) {
      const token = bericht.tekst.match(/\/person\/(\S+)/)?.[1];
      expect(token).toBeDefined();
      const owner = db
        .prepare('SELECT person_id FROM dienstrooster_person_access_link WHERE token_hash = ?')
        .get(hashToken(token!)) as { person_id: string } | undefined;
      expect(owner && codenaam(owner.person_id)).toBe(bericht.codenaam);
      expect(bericht.onderwerp).toContain('Voorjaar 2099');
      expect(bericht.personen).toEqual([bericht.codenaam]);
    }
    expect(linkCount(f.gone, f.periodId)).toBe(0);

    expect(verzendlijstPayload(mail.raw)).toMatchObject({
      soort: 'UITNODIGING',
      automatisch: false,
      periode: 'Voorjaar 2099',
      deadline: '2099-02-01T17:00',
      aantal: 2,
      nog_niets_ingevuld: null,
      nog_niet_ingediend: null,
    });
  });

  it('sends the reminders exactly as the planner edited them', async () => {
    configure();
    const f = createFixture();
    const berichten = [{ codenaam: codenaam(f.a), onderwerp: 'Herinnering', tekst: 'Hoi, je link: https://x/person/abc' }];
    const res = await sendReminders(
      plannerRequest(`http://localhost/api/exports/reminders/${f.periodId}/send`, f.planner, {
        deadline: '2099-02-01T17:00',
        berichten,
      }),
      { params: Promise.resolve({ 'period-id': f.periodId }) }
    );
    expect(res.status).toBe(200);
    // soort and personen are set by the server: a reminder names only its recipient.
    expect(attachment(sink.received[0].raw)).toEqual([
      { ...berichten[0], soort: 'HERINNERING', personen: [codenaam(f.a)] },
    ]);
    // Nobody handed in or started in this fixture: all in the first group.
    expect(verzendlijstPayload(sink.received[0].raw)).toMatchObject({
      soort: 'HERINNERING',
      automatisch: false,
      aantal: 1,
      nog_niets_ingevuld: 1,
      nog_niet_ingediend: 0,
    });
  });

  it('refuses a codenaam that does not take part in the period, and sends nothing', async () => {
    configure();
    const f = createFixture();
    const res = await sendReminders(
      plannerRequest(`http://localhost/api/exports/reminders/${f.periodId}/send`, f.planner, {
        deadline: '2099-02-01T17:00',
        berichten: [
          { codenaam: codenaam(f.a), onderwerp: 'H', tekst: 'T' },
          { codenaam: codenaam(f.gone), onderwerp: 'H', tekst: 'T' },
        ],
      }),
      { params: Promise.resolve({ 'period-id': f.periodId }) }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain(codenaam(f.gone));
    expect(sink.received).toHaveLength(0);
  });

  it('issues no links and sends nothing when the server is not set up to send', async () => {
    const f = createFixture();
    const res = await sendInvitations(
      plannerRequest(`http://localhost/api/exports/invitations/${f.periodId}/send`, f.planner),
      { params: Promise.resolve({ 'period-id': f.periodId }) }
    );
    expect(res.status).toBe(409);
    expect(linkCount(f.a, f.periodId)).toBe(0);
    expect(sink.received).toHaveLength(0);
  });

  it('explains a refused login in Dutch instead of a raw SMTP error', async () => {
    configure({ SMTP_PASS: 'verkeerd' });
    const f = createFixture();
    const res = await sendInvitations(
      plannerRequest(`http://localhost/api/exports/invitations/${f.periodId}/send`, f.planner),
      { params: Promise.resolve({ 'period-id': f.periodId }) }
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/app-wachtwoord/);
    expect(sink.received).toHaveLength(0);
  });

  it('refuses anyone who is not a planner', async () => {
    configure();
    const f = createFixture();
    const res = await sendInvitations(
      new NextRequest(`http://localhost/api/exports/invitations/${f.periodId}/send`, { method: 'POST' }),
      { params: Promise.resolve({ 'period-id': f.periodId }) }
    );
    expect(res.status).toBe(401);
    expect(sink.received).toHaveLength(0);
  });

  it('refuses reminders written for a deadline that has since been moved, and sends nothing', async () => {
    configure();
    const f = createFixture();
    db.prepare("UPDATE dienstrooster_schedule_period SET deadline = '2099-02-08T17:00' WHERE id = ?").run(f.periodId);
    const res = await sendReminders(
      plannerRequest(`http://localhost/api/exports/reminders/${f.periodId}/send`, f.planner, {
        deadline: '2099-02-01T17:00',
        berichten: [{ codenaam: codenaam(f.a), onderwerp: 'H', tekst: 'Uiterlijk 1 februari' }],
      }),
      { params: Promise.resolve({ 'period-id': f.periodId }) }
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DEADLINE_CHANGED');
    expect(sink.received).toHaveLength(0);
  });

  it('refuses reminders once the deadline has passed, and sends nothing', async () => {
    configure();
    const f = createFixture();
    db.prepare("UPDATE dienstrooster_schedule_period SET deadline = '2020-01-01T17:00' WHERE id = ?").run(f.periodId);
    const res = await sendReminders(
      plannerRequest(`http://localhost/api/exports/reminders/${f.periodId}/send`, f.planner, {
        deadline: '2020-01-01T17:00',
        berichten: [{ codenaam: codenaam(f.a), onderwerp: 'H', tekst: 'T' }],
      }),
      { params: Promise.resolve({ 'period-id': f.periodId }) }
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DEADLINE_PASSED');
    expect(sink.received).toHaveLength(0);
  });
});
