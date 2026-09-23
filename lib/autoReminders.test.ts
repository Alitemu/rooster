import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fc from 'fast-check';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import {
  startSmtpSink,
  configureSmtp,
  clearSmtpConfig,
  verzendlijstAttachment,
  type SmtpSink,
} from '@/tests/smtpSink';
import { SAMENVATTING_SUBJECT } from './verzendlijst';
import { reminderMoment, runAutoReminders, logRemindersSent, CATCH_UP_MS, autoReminderStatus } from './autoReminders';

/**
 * The rules:
 * - the moment for a milestone of N days is 09:00, at least N and less
 *   than N+1 days before the deadline: the last one lands 24 to 48 hours
 *   before it.
 * - at that moment everyone who hasn't handed in gets one reminder, with
 *   the text for their own situation; nobody who handed in does.
 * - a moment goes out once. Not twice, not after a restart, not late by
 *   more than the catch-up window, and never together with an older one.
 * - moving the deadline gives it its own moments.
 * - paused, not set up to mail, or reminded by hand within the day: nothing.
 * - the planner gets a summary with the kind of reminder and the counts.
 */

let sink: SmtpSink;
beforeAll(async () => {
  sink = await startSmtpSink();
});
afterAll(async () => {
  await sink.close();
});

const HOUR = 60 * 60 * 1000;
const created = { pools: [] as string[], people: [] as string[], periods: [] as string[] };

// A Wednesday, 17:00 local time.
const DEADLINE = '2099-03-11T17:00';

function createFixture(deadline = DEADLINE) {
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
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, basis_url, aangemaakt_op)
     VALUES (?, ?, 'Voorjaar 2099', '2099-03-16', '2099-05-10', ?, 'OPEN', 'https://rooster.test', datetime('now'))`
  ).run(periodId, poolId, deadline);
  created.periods.push(periodId);

  const person = (status: 'NIET_BEGONNEN' | 'BEZIG' | 'BEVESTIGD' | null, member = true) => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
    ).run(id, `AH-${id.slice(0, 8)}`);
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, ?, '2100-12-31')`
    ).run(crypto.randomUUID(), id, poolId, member ? '2020-01-01' : '2099-06-01');
    if (status) {
      db.prepare(
        `INSERT INTO dienstrooster_submission (id, person_id, schedule_period_id, status, aangemaakt_op)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(crypto.randomUUID(), id, periodId, status);
    }
    created.people.push(id);
    return id;
  };

  return {
    periodId,
    nietsIngevuld: person(null),
    nietBegonnen: person('NIET_BEGONNEN'),
    bezig: person('BEZIG'),
    ingediend: person('BEVESTIGD'),
    geenLid: person(null, false),
  };
}

function codenaam(id: string) {
  return (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(id) as { codenaam: string }).codenaam;
}

const verzendlijsten = () => sink.received.filter((m) => !m.raw.includes(`Subject: ${SAMENVATTING_SUBJECT}`));
const samenvattingen = () => sink.received.filter((m) => m.raw.includes(`Subject: ${SAMENVATTING_SUBJECT}`));
const moment = (dagen: number, deadline = DEADLINE) => reminderMoment(new Date(deadline), dagen);
/** Only this file's periods: the test database is shared with other files. */
const run = (now: Date) => runAutoReminders(now, { onlyPeriodIds: created.periods });
const runs = (periodId: string) =>
  db
    .prepare('SELECT dagen_voor_deadline, uitkomst FROM dienstrooster_reminder_run WHERE period_id = ? ORDER BY dagen_voor_deadline')
    .all(periodId);

afterEach(() => {
  clearSmtpConfig();
  sink.received.length = 0;
  for (const poolId of created.pools) {
    for (const { id } of db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?').all(poolId) as Array<{
      id: string;
    }>) {
      db.prepare('DELETE FROM dienstrooster_reminder_run WHERE period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_notification_log WHERE period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_submission WHERE schedule_period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').run(id);
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
  created.periods = [];
});

describe('reminderMoment', () => {
  it('puts the last reminder at 09:00 the day before, when that is at least a day ahead', () => {
    // Wednesday 17:00 -> Tuesday 09:00 (32 hours before).
    expect(reminderMoment(new Date('2099-03-11T17:00'), 1)).toEqual(new Date('2099-03-10T09:00'));
  });

  it('goes a day further back when 09:00 the day before is less than a day ahead', () => {
    // Wednesday 08:00 -> Monday 09:00 (47 hours before), not Tuesday (23).
    expect(reminderMoment(new Date('2099-03-11T08:00'), 1)).toEqual(new Date('2099-03-09T09:00'));
  });

  it('is always 09:00, at least N and less than N+1 days before the deadline', () => {
    const start = new Date('2026-01-01T00:00').getTime();
    fc.assert(
      fc.property(
        // Two years of deadlines, whole minutes, across both DST changes.
        fc.integer({ min: 0, max: 2 * 365 * 24 * 60 }),
        fc.constantFrom(1, 2, 7, 14, 21),
        (minutes, dagen) => {
          const deadline = new Date(start + minutes * 60 * 1000);
          const m = reminderMoment(deadline, dagen);
          const before = deadline.getTime() - m.getTime();
          expect(m.getHours()).toBe(9);
          expect(m.getMinutes()).toBe(0);
          // Never less than N*24 hours: the last reminder always leaves a
          // full day. Stepping back a calendar day across a DST change can
          // add an hour at the far end.
          expect(before).toBeGreaterThanOrEqual(dagen * 24 * HOUR);
          expect(before).toBeLessThan((dagen + 1) * 24 * HOUR + HOUR);
        }
      )
    );
  });
});

describe('runAutoReminders', () => {
  it('sends nothing before the moment', async () => {
    configureSmtp(sink);
    const f = createFixture();
    await run(new Date(moment(7).getTime() - 60 * 1000));
    expect(sink.received).toHaveLength(0);
    expect(runs(f.periodId)).toHaveLength(0);
  });

  it('reminds everyone who has not handed in, each with the text for their situation', async () => {
    configureSmtp(sink);
    const f = createFixture();
    await run(moment(7));

    expect(verzendlijsten()).toHaveLength(1);
    const berichten = verzendlijstAttachment(verzendlijsten()[0].raw);
    const byCode = new Map(berichten.map((b) => [b.codenaam, b]));
    expect([...byCode.keys()].sort()).toEqual(
      [codenaam(f.nietsIngevuld), codenaam(f.nietBegonnen), codenaam(f.bezig)].sort()
    );

    const nieuw = byCode.get(codenaam(f.nietsIngevuld))!;
    expect(nieuw.soort).toBe('HERINNERING');
    expect(nieuw.tekst).toContain('nog niet ingevuld');
    expect(nieuw.tekst).toContain('woensdag 11 maart 2099 om 17:00');
    expect(byCode.get(codenaam(f.nietBegonnen))!.tekst).toContain('nog niet ingevuld');

    const begonnen = byCode.get(codenaam(f.bezig))!;
    expect(begonnen.onderwerp).toContain('nog niet ingediend');
    expect(begonnen.tekst).toContain('Bevestigen en indienen');

    // Each link opens that person's own page.
    for (const b of berichten) {
      const token = b.tekst.match(/\/person\/(\S+)/)?.[1];
      const owner = db
        .prepare('SELECT person_id FROM dienstrooster_person_access_link WHERE token_hash = ?')
        .get(hashToken(token!)) as { person_id: string };
      expect(codenaam(owner.person_id)).toBe(b.codenaam);
    }
  });

  it('sends the planner a summary with the kind of reminder and the counts', async () => {
    configureSmtp(sink);
    const f = createFixture();
    await run(moment(1));

    expect(samenvattingen()).toHaveLength(1);
    const raw = samenvattingen()[0].raw;
    const part = raw.split(/\r?\n--/).find((p) => /application\/json/i.test(p))!;
    const [headers, ...rest] = part.split(/\r?\n\r?\n/);
    const body = rest.join('\n\n').trim();
    const json = JSON.parse(
      /base64/i.test(headers) ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') : body
    );
    expect(json).toMatchObject({
      soort: 'LAATSTE_HERINNERING',
      automatisch: true,
      periode: 'Voorjaar 2099',
      deadline: DEADLINE,
      dagen_voor_deadline: 1,
      aantal: 3,
      nog_niets_ingevuld: 2,
      nog_niet_ingediend: 1,
    });
    expect(json.ontvangers.nog_niet_ingediend).toEqual([codenaam(f.bezig)]);
  });

  it('marks the last moment as the last reminder', async () => {
    configureSmtp(sink);
    createFixture();
    await run(moment(1));
    const [b] = verzendlijstAttachment(verzendlijsten()[0].raw);
    expect(b.soort).toBe('LAATSTE_HERINNERING');
    expect(b.onderwerp).toMatch(/^Laatste herinnering/);
    expect(b.tekst).toContain('Dit is de laatste herinnering');
  });

  it('sends a moment once, however often it runs', async () => {
    configureSmtp(sink);
    const f = createFixture();
    await run(moment(7));
    await run(new Date(moment(7).getTime() + 15 * 60 * 1000));
    await run(new Date(moment(7).getTime() + 2 * HOUR));
    expect(verzendlijsten()).toHaveLength(1);
    expect(runs(f.periodId)).toEqual([{ dagen_voor_deadline: 7, uitkomst: 'VERSTUURD' }]);
  });

  it('still sends shortly after the moment, but skips it once the catch-up window is over', async () => {
    configureSmtp(sink);
    const late = createFixture();
    await run(new Date(moment(7).getTime() + CATCH_UP_MS - 60 * 1000));
    expect(verzendlijsten()).toHaveLength(1);

    sink.received.length = 0;
    const tooLate = createFixture('2099-03-12T17:00');
    await run(new Date(moment(7, '2099-03-12T17:00').getTime() + CATCH_UP_MS + 60 * 1000));
    expect(verzendlijsten()).toHaveLength(0);
    expect(runs(tooLate.periodId)).toEqual([{ dagen_voor_deadline: 7, uitkomst: 'OVERGESLAGEN' }]);
    expect(runs(late.periodId)).toEqual([{ dagen_voor_deadline: 7, uitkomst: 'VERSTUURD' }]);
  });

  it('sends only the most urgent when several moments are due at once', async () => {
    configureSmtp(sink);
    const f = createFixture();
    await run(moment(1));
    expect(verzendlijsten()).toHaveLength(1);
    expect(verzendlijstAttachment(verzendlijsten()[0].raw)[0].soort).toBe('LAATSTE_HERINNERING');
    expect(runs(f.periodId)).toEqual([
      { dagen_voor_deadline: 1, uitkomst: 'VERSTUURD' },
      { dagen_voor_deadline: 7, uitkomst: 'OVERGESLAGEN' },
    ]);
  });

  it('gives a moved deadline its own moments, with the new date in the text', async () => {
    configureSmtp(sink);
    const f = createFixture();
    await run(moment(7));
    const nieuw = '2099-03-18T17:00';
    db.prepare('UPDATE dienstrooster_schedule_period SET deadline = ? WHERE id = ?').run(nieuw, f.periodId);
    // Two days after the first send: nobody was reminded in the last day.
    await run(moment(7, nieuw));
    expect(verzendlijsten()).toHaveLength(2);
    expect(verzendlijstAttachment(verzendlijsten()[1].raw)[0].tekst).toContain('woensdag 18 maart 2099');
  });

  it('leaves out anyone the planner reminded by hand within the last day', async () => {
    configureSmtp(sink);
    const f = createFixture();
    logRemindersSent([f.bezig], f.periodId, false, new Date(moment(7).getTime() - 2 * HOUR));
    await run(moment(7));
    const codes = verzendlijstAttachment(verzendlijsten()[0].raw).map((b) => b.codenaam);
    expect(codes).not.toContain(codenaam(f.bezig));
    expect(codes).toContain(codenaam(f.nietsIngevuld));
  });

  it('does nothing for a paused period', async () => {
    configureSmtp(sink);
    const f = createFixture();
    db.prepare('UPDATE dienstrooster_schedule_period SET auto_herinneren = 0 WHERE id = ?').run(f.periodId);
    await run(moment(7));
    expect(sink.received).toHaveLength(0);
    expect(runs(f.periodId)).toHaveLength(0);
  });

  it('does nothing, and claims nothing, while mail is not set up', async () => {
    const f = createFixture();
    await run(moment(7));
    expect(runs(f.periodId)).toHaveLength(0);
    // Set up an hour later: still inside the window, so it goes after all.
    configureSmtp(sink);
    await run(new Date(moment(7).getTime() + HOUR));
    expect(verzendlijsten()).toHaveLength(1);
  });

  it('tries again next time when the mail server refuses', async () => {
    configureSmtp(sink, { SMTP_PASS: 'verkeerd' });
    const f = createFixture();
    const [result] = await run(moment(7));
    expect(result.uitkomst).toBe('MISLUKT');
    expect(runs(f.periodId)).toHaveLength(0);

    configureSmtp(sink);
    await run(new Date(moment(7).getTime() + 15 * 60 * 1000));
    expect(verzendlijsten()).toHaveLength(1);
  });

  it('never sends after the deadline', async () => {
    configureSmtp(sink);
    const f = createFixture();
    await run(new Date(new Date(DEADLINE).getTime() + 60 * 1000));
    expect(sink.received).toHaveLength(0);
    expect(runs(f.periodId)).toHaveLength(0);
  });

  it('tells the dashboard what comes next and for how many people', () => {
    configureSmtp(sink);
    const f = createFixture();
    const status = autoReminderStatus(f.periodId, new Date(moment(7).getTime() - HOUR))!;
    expect(status).toMatchObject({ aan: true, mailIngesteld: true, adresBekend: true, periodeOpen: true });
    expect(status.volgende).toMatchObject({
      moment: moment(7).toISOString(),
      laatste: false,
      nogNietsIngevuld: 2,
      nogNietIngediend: 1,
    });
  });
});
