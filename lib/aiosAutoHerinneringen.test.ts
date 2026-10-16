import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { bewaarAiosStroomAdres } from '@/lib/aiosMail';
import { runAutoReminders } from '@/lib/autoReminders';
import {
  startSmtpSink,
  configureSmtp,
  clearSmtpConfig,
  verzendlijstAttachment,
  verzendlijstPayload,
  type SmtpSink,
} from '@/tests/smtpSink';
import { reminderMoment } from './autoReminders';
import { aiosAutoHerinnerStatus, runAiosAutoHerinneringen, zetAiosAutoHerinneren } from './aiosAutoHerinneringen';
import { logAiosHerinneringen } from './aiosUitnodigen';
import { GET as statusRoute, PATCH as zetRoute } from '@/app/api/aios/periode/[id]/auto-herinneringen/route';
import { staffCookie } from '@/tests/fixtures/dienstWorlds';

/**
 * The rules, as for the achterwacht's (lib/autoReminders.test.ts), for the
 * AIOS's own copy:
 * - at each moment every AIOS who hasn't handed in gets one reminder, to
 *   the AIOS's own flow, with a link to their own page (/aios/<token>);
 *   nobody who handed in does, nor anyone reminded in the last day.
 * - a moment goes out once, and the last one as the last reminder.
 * - paused for the period, or the AIOS's mail not set up: nothing, and
 *   nothing claimed. A refused send is given back for the next tick.
 * - apart: the AIOS's copy never sends for an achterwacht period, the
 *   achterwacht's never for an AIOS period.
 */

const AAN = 'stroom@example.test';
const AAN_AIOS = 'stroom-aios@example.test';
// A Wednesday, 17:00 local time.
const DEADLINE = '2099-03-11T17:00';
const HOUR = 60 * 60 * 1000;

let sink: SmtpSink;
const gemaakt = { pools: [] as string[], mensen: [] as string[] };
const staf: Record<'beheerder' | 'aiosPlanner' | 'stafPlanner', string> = { beheerder: '', aiosPlanner: '', stafPlanner: '' };

function stafAccount(rol: 'ADMIN' | 'PLANNER', dienst: 'ACHTERWACHT' | 'AIOS'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, dienst_type, aangemaakt_op) VALUES (?, ?, ?, 1, ?, datetime('now'))`
  ).run(id, `AAH-${rol}-${id.slice(0, 6)}`, rol, dienst);
  return id;
}

beforeAll(async () => {
  sink = await startSmtpSink();
  staf.beheerder = stafAccount('ADMIN', 'ACHTERWACHT');
  staf.aiosPlanner = stafAccount('PLANNER', 'AIOS');
  staf.stafPlanner = stafAccount('PLANNER', 'ACHTERWACHT');
});
afterAll(async () => {
  for (const id of Object.values(staf)) {
    db.prepare('DELETE FROM dienstrooster_app_setting WHERE gewijzigd_door = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
  await sink.close();
});

function wereld(type: 'AIOS' | 'ACHTERWACHT') {
  const rulesetId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`).run(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, type, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(poolId, `Pool ${type}`, type, rulesetId);
  gemaakt.pools.push(poolId);
  const periodId = crypto.randomUUID();
  // The achterwacht's period with its own switch on, the AIOS's off as opening leaves it (lib/aiosOpen.ts).
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, basis_url, auto_herinneren, aangemaakt_op)
     VALUES (?, ?, 'Kwartaal 2099', '2099-04-01', '2099-06-30', ?, 'OPEN', 'https://rooster.test', ?, datetime('now'))`
  ).run(periodId, poolId, DEADLINE, type === 'AIOS' ? 0 : 1);
  if (type === 'AIOS') {
    db.prepare(`INSERT INTO dienstrooster_aios_periode (period_id, uitgenodigd_op, basis_url) VALUES (?, datetime('now'), 'https://rooster.test')`).run(periodId);
  }
  const persoon = (status: 'BEZIG' | 'BEVESTIGD' | null) => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
    ).run(id, `AAH-${id.slice(0, 8)}`);
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, '2020-01-01', '2100-12-31')`
    ).run(crypto.randomUUID(), id, poolId);
    if (status) {
      db.prepare(
        `INSERT INTO dienstrooster_submission (id, person_id, schedule_period_id, status, aangemaakt_op) VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(crypto.randomUUID(), id, periodId, status);
    }
    gemaakt.mensen.push(id);
    return id;
  };
  return { periodId, nietsIngevuld: persoon(null), bezig: persoon('BEZIG'), ingediend: persoon('BEVESTIGD') };
}

const codenaam = (id: string) =>
  (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(id) as { codenaam: string }).codenaam;
const moment = (dagen: number) => reminderMoment(new Date(DEADLINE), dagen);
const periodes = () =>
  (db.prepare(`SELECT id FROM dienstrooster_schedule_period WHERE pool_id IN (${gemaakt.pools.map(() => '?').join(',')})`).all(...gemaakt.pools) as Array<{ id: string }>).map((r) => r.id);
/** Only this file's periods: the test database is shared with other files. */
const run = (now: Date) => runAiosAutoHerinneringen(now, { alleenPeriodes: periodes() });
const claims = (periodId: string) =>
  db.prepare('SELECT dagen_voor_deadline, uitkomst FROM dienstrooster_reminder_run WHERE period_id = ?').all(periodId);
const mailAan = () => {
  configureSmtp(sink, { aan: AAN });
  bewaarAiosStroomAdres(AAN_AIOS, staf.beheerder);
};

afterEach(() => {
  bewaarAiosStroomAdres('', staf.beheerder);
  clearSmtpConfig();
  sink.received.length = 0;
  for (const id of periodes()) {
    for (const t of ['dienstrooster_reminder_run', 'dienstrooster_notification_log', 'dienstrooster_aios_periode']) {
      db.prepare(`DELETE FROM ${t} WHERE period_id = ?`).run(id);
    }
    db.prepare('DELETE FROM dienstrooster_submission WHERE schedule_period_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
  }
  for (const poolId of gemaakt.pools) {
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as { ruleset_id: string };
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  for (const id of gemaakt.mensen) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  gemaakt.pools.length = 0;
  gemaakt.mensen.length = 0;
});

describe("the AIOS's automatic reminders", () => {
  it('send nothing before the moment', async () => {
    mailAan();
    const w = wereld('AIOS');
    await run(new Date(moment(7).getTime() - 60 * 1000));
    expect(sink.received).toHaveLength(0);
    expect(claims(w.periodId)).toHaveLength(0);
  });

  it("remind every AIOS who has not handed in, through the AIOS's flow, with a link to their own page", async () => {
    mailAan();
    const w = wereld('AIOS');
    await run(moment(7));

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].to).toEqual([AAN_AIOS]);
    const lijst = verzendlijstPayload(sink.received[0].raw);
    expect(lijst).toMatchObject({ soort: 'HERINNERING', automatisch: true, aantal: 2, nog_niets_ingevuld: 1, nog_niet_ingediend: 1 });
    const berichten = verzendlijstAttachment(sink.received[0].raw);
    expect(berichten.map((b) => b.codenaam).sort()).toEqual([codenaam(w.nietsIngevuld), codenaam(w.bezig)].sort());
    expect(berichten.find((b) => b.codenaam === codenaam(w.bezig))!.tekst).toContain('Bevestigen en indienen');
    for (const b of berichten) {
      expect(b.tekst).not.toContain('/person/');
      const token = b.tekst.match(/\/aios\/(\S+)/)?.[1];
      const eigenaar = db.prepare('SELECT person_id FROM dienstrooster_person_access_link WHERE token_hash = ?').get(hashToken(token!)) as {
        person_id: string;
      };
      expect(codenaam(eigenaar.person_id)).toBe(b.codenaam);
    }
  });

  it('send a moment once, however often they run, and the last one as the last reminder', async () => {
    mailAan();
    const w = wereld('AIOS');
    await run(moment(7));
    await run(new Date(moment(7).getTime() + 2 * HOUR));
    expect(sink.received).toHaveLength(1);
    // The week's moment, already sent, is not reported again as skipped.
    expect(await run(moment(1))).toEqual([{ periodId: w.periodId, dagen: 1, uitkomst: 'VERSTUURD', aantal: 2 }]);
    await run(new Date(moment(1).getTime() + HOUR));
    expect(sink.received).toHaveLength(2);
    const [b] = verzendlijstAttachment(sink.received[1].raw);
    expect(b.soort).toBe('LAATSTE_HERINNERING');
    expect(b.tekst).toContain('Dit is de laatste herinnering');
    expect(claims(w.periodId)).toHaveLength(2);
  });

  it('leave out an AIOS reminded by hand within the last day', async () => {
    mailAan();
    const w = wereld('AIOS');
    logAiosHerinneringen([w.bezig], w.periodId, false, new Date(moment(7).getTime() - HOUR));
    await run(moment(7));
    expect(verzendlijstAttachment(sink.received[0].raw).map((b) => b.codenaam)).toEqual([codenaam(w.nietsIngevuld)]);
  });

  it('do nothing for a paused period, and send again once it is back on', async () => {
    mailAan();
    const w = wereld('AIOS');
    zetAiosAutoHerinneren(w.periodId, false);
    await run(moment(7));
    expect(sink.received).toHaveLength(0);
    expect(claims(w.periodId)).toHaveLength(0);
    zetAiosAutoHerinneren(w.periodId, true);
    await run(moment(7));
    expect(sink.received).toHaveLength(1);
  });

  it("do nothing, and claim nothing, while the AIOS's flow has no address", async () => {
    configureSmtp(sink, { aan: AAN });
    const w = wereld('AIOS');
    await run(moment(7));
    expect(sink.received).toHaveLength(0);
    expect(claims(w.periodId)).toHaveLength(0);
  });

  it('try again next time when the mail server refuses', async () => {
    mailAan();
    const w = wereld('AIOS');
    const port = process.env.SMTP_PORT;
    process.env.SMTP_PORT = '1';
    const [uitkomst] = await run(moment(7));
    expect(uitkomst.uitkomst).toBe('MISLUKT');
    expect(claims(w.periodId)).toHaveLength(0);
    process.env.SMTP_PORT = port;
    await run(new Date(moment(7).getTime() + HOUR));
    expect(sink.received).toHaveLength(1);
  });

  it("never send for an achterwacht period, and the achterwacht's never for an AIOS period", async () => {
    mailAan();
    const aios = wereld('AIOS');
    const staf = wereld('ACHTERWACHT');
    await run(moment(7));
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].to).toEqual([AAN_AIOS]);
    expect(claims(staf.periodId)).toHaveLength(0);

    await runAutoReminders(moment(7), { onlyPeriodIds: [aios.periodId, staf.periodId] });
    expect(sink.received).toHaveLength(2);
    expect(sink.received[1].to).toEqual([AAN]);
    expect(verzendlijstAttachment(sink.received[1].raw).every((b) => b.tekst.includes('/person/'))).toBe(true);
    // The AIOS period's one claim is still the AIOS's own.
    expect(claims(aios.periodId)).toHaveLength(1);
  });

  it("tell the AIOS period's page what comes next, and switch through its route for an AIOS planner only", async () => {
    mailAan();
    const w = wereld('AIOS');
    const status = aiosAutoHerinnerStatus(w.periodId, new Date(moment(7).getTime() - HOUR))!;
    expect(status).toMatchObject({ aan: true, mailIngesteld: true, adresBekend: true, periodeOpen: true });
    expect(status.volgende).toMatchObject({ laatste: false, nogNietsIngevuld: 1, nogNietIngediend: 1 });

    const ctx = { params: Promise.resolve({ id: w.periodId }) };
    const url = `http://localhost/api/aios/periode/${w.periodId}/auto-herinneringen`;
    const patch = (cookie: string, body: unknown) =>
      zetRoute(new NextRequest(url, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }), ctx);
    const aiosPlanner = staffCookie(staf.aiosPlanner);
    const stafPlanner = staffCookie(staf.stafPlanner);

    expect((await patch(stafPlanner, { aan: false })).status).toBe(404);
    expect((await patch(aiosPlanner, { aan: 'nee' })).status).toBe(400);
    const uit = await patch(aiosPlanner, { aan: false });
    expect(uit.status).toBe(200);
    expect((await uit.json()).data.aan).toBe(false);
    const get = await statusRoute(new NextRequest(url, { headers: { cookie: aiosPlanner } }), ctx);
    expect((await get.json()).data.aan).toBe(false);
    // The achterwacht's own switch on the period stays off.
    expect((db.prepare('SELECT auto_herinneren FROM dienstrooster_schedule_period WHERE id = ?').get(w.periodId) as { auto_herinneren: number }).auto_herinneren).toBe(0);
  });
});
