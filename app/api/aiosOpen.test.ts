import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { flushMailQueue, mailMelding, queuedMailCount } from '@/lib/meldingMail';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, waitForMails, type SmtpSink } from '@/tests/smtpSink';
import { POST as openPeriod } from './periods/[id]/open/route';
import { POST as sendInvitations } from './exports/invitations/[period-id]/send/route';
import { GET as mailSettings, PUT as saveMailSettingsRoute } from './planner/mail-settings/route';
import { GET as swapContacts } from './person/[id]/swap-contacts/route';
import { GET as verzendlijstStatus } from './exports/verzendlijst-status/route';
import { POST as linkAanvragen } from './link-aanvragen/route';
import {
  buildWorld,
  deleteRowsAfter,
  insert,
  now,
  personCookie,
  rowidSnapshot,
  staff,
  staffCookie,
  tag,
  type World,
} from '../../tests/fixtures/dienstWorlds';

/**
 * Step 2 for the planner (docs/aios-rooster.md, lib/aiosOpen.ts): an AIOS
 * period opens by its own rules, and everything it mails goes to the
 * AIOS's own flow (lib/verzendlijstMail.ts):
 * - opening needs only a deadline, before the quarter and not past, and an
 *   AIOS taking part; it freezes no ruleset and marks the diensten from
 *   the absences entered before it opened;
 * - the achterwacht's opening still asks its ruleset: the AIOS branch takes
 *   no achterwacht period;
 * - invitations go to the AIOS's flow address, with their own text, and
 *   not at all while that address is missing; the achterwacht's go to
 *   theirs;
 * - a participant's swap dialog names the flow of their own dienst, and a
 *   planner's Mailinstellingen show only their own dienst's address;
 * - "Link kwijt?" sends one verzendlijst to each flow, and a swap mail of
 *   the AIOS waits while their flow has no address, without holding up
 *   the achterwacht's.
 */

const AAN = 'stroom@example.test';
const AAN_AIOS = 'stroom-aios@example.test';

let snapshot: Map<string, number>;
let sink: SmtpSink;
let staf: World;
const aios = {} as { pool: string; period: string; planner: string; admin: string; x: string; codenaam: string; start: string };

function ctx<P extends Record<string, string>>(params: P) {
  return { params: Promise.resolve(params) };
}

function req(url: string, method: string, cookie: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function period(id: string) {
  return db.prepare('SELECT status, deadline, bevroren_ruleset_json, uitgenodigd_op FROM dienstrooster_schedule_period WHERE id = ?').get(id) as {
    status: string;
    deadline: string;
    bevroren_ruleset_json: string | null;
    uitgenodigd_op: string | null;
  };
}

function setStatus(id: string, status: string) {
  db.prepare('UPDATE dienstrooster_schedule_period SET status = ?, uitgenodigd_op = NULL WHERE id = ?').run(status, id);
}

beforeAll(async () => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  aios.planner = staff('PLANNER', 'AIOS');
  aios.admin = staff('ADMIN', 'ACHTERWACHT');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosOpen-${tag}`, config_json: '{}', aangemaakt_op: now });
  aios.pool = insert('dienstrooster_pool', { naam: `AiosOpen-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, aios.pool);
  const q = aiosQuarter(2097, 1);
  aios.start = q.start_datum;
  aios.period = insert('dienstrooster_schedule_period', {
    pool_id: aios.pool,
    naam: `AiosOpen-${tag}`,
    start_datum: q.start_datum,
    eind_datum: q.eind_datum,
    deadline: '2096-11-11T17:00',
    status: 'CONCEPT',
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(aios.period, aiosShiftTypes(aios.pool)!, q.start_datum, q.eind_datum))();
  aios.codenaam = `aiosopen-x-${tag}`;
  aios.x = insert('dienstrooster_person', { codenaam: aios.codenaam, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  insert('dienstrooster_person_access_link', { person_id: aios.x, token_hash: `aiosopen-${tag}`, aangemaakt_op: now });
  // A week's leave entered before the period opened: opening marks it.
  insert('dienstrooster_absence', {
    person_id: aios.x,
    van_datum: '2097-02-03',
    tot_datum: '2097-02-04',
    soort: 'VAKANTIE',
    aangemaakt_door: aios.x,
    aangemaakt_op: now,
  });
  sink = await startSmtpSink();
});

afterAll(async () => {
  clearSmtpConfig();
  await sink.close();
  deleteRowsAfter(snapshot);
});

beforeEach(() => {
  sink.received.length = 0;
});

describe('opening an AIOS period', () => {
  const open = (body: unknown) => openPeriod(req(`periods/${aios.period}/open`, 'POST', staffCookie(aios.planner), body), ctx({ id: aios.period }));

  it('refuses while no AIOS takes part in the quarter', async () => {
    const res = await open({});
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Er doet nog geen AIOS mee/);
    expect(period(aios.period).status).toBe('CONCEPT');
  });

  it('refuses a deadline in the past or on or after the start', async () => {
    insert('dienstrooster_pool_membership', { person_id: aios.x, pool_id: aios.pool, deelnamefactor: 1, geldig_vanaf: '2096-01-01', geldig_tot: '2098-12-31' });
    for (const deadline of ['2020-01-01T17:00', `${aios.start}T00:00`, 'morgen', 12]) {
      const res = await open({ deadline });
      expect(res.status, String(deadline)).toBe(400);
      expect((await res.json()).error.code).toBe('INVALID_DEADLINE');
    }
    expect(period(aios.period).status).toBe('CONCEPT');
  });

  it('opens with only a deadline, freezes no ruleset and marks the leave entered before', async () => {
    const res = await open({ deadline: '2096-11-12T17:00' });
    expect(res.status, await res.clone().text()).toBe(200);
    const p = period(aios.period);
    expect(p.status).toBe('OPEN');
    expect(p.deadline).toBe('2096-11-12T17:00');
    expect(p.bevroren_ruleset_json).toBeNull();
    const verlof = db
      .prepare(
        `SELECT DISTINCT av.blocking_level FROM dienstrooster_availability av
         JOIN dienstrooster_shift_slot s ON s.id = av.slot_id
         WHERE av.person_id = ? AND s.period_id = ? AND av.source = 'ABSENCE'`
      )
      .all(aios.x, aios.period) as Array<{ blocking_level: string }>;
    expect(verlof.map((v) => v.blocking_level)).toEqual(['ABSOLUUT']);
  });

  it('opens only once', async () => {
    const res = await open({});
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_STATUS');
  });

  it("leaves the achterwacht's opening as it was: it still asks its ruleset", async () => {
    setStatus(staf.period, 'CONCEPT');
    try {
      const res = await openPeriod(req(`periods/${staf.period}/open`, 'POST', staffCookie(staf.planner), { deadline: '2098-02-20T17:00' }), ctx({ id: staf.period }));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('MISSING_FIELDS');
      expect(period(staf.period).status).toBe('CONCEPT');
    } finally {
      setStatus(staf.period, 'GEPUBLICEERD');
    }
  });
});

describe("the AIOS's mail goes to their own flow", () => {
  const invite = (id: string, planner: string) =>
    sendInvitations(req(`exports/invitations/${id}/send`, 'POST', staffCookie(planner), {}), ctx({ 'period-id': id }));

  it('sends no invitation of the AIOS while their flow has no address, and issues no links', async () => {
    configureSmtp(sink, { aan: AAN });
    const links = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').get(aios.period) as { n: number }).n;
    const voor = links();
    const res = await invite(aios.period, aios.planner);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NOT_CONFIGURED');
    expect(links()).toBe(voor);
    expect(sink.received).toHaveLength(0);
    const status = await verzendlijstStatus(req(`exports/verzendlijst-status?period_id=${aios.period}`, 'GET', staffCookie(aios.planner)));
    expect((await status.json()).data.ingesteld).toBe(false);
  });

  it("sends the AIOS's invitations to their flow, with their own text", async () => {
    configureSmtp(sink, { aan: AAN, aanAios: AAN_AIOS });
    const res = await invite(aios.period, aios.planner);
    expect(res.status, await res.clone().text()).toBe(200);
    await waitForMails(sink, 1);
    expect(sink.received[0].to).toEqual([AAN_AIOS]);
    const lijst = verzendlijstPayload(sink.received[0].raw);
    const bericht = lijst.berichten.find((b) => b.codenaam === aios.codenaam)!;
    expect(bericht.tekst).toMatch(/Het rooster van de AIOS voor/);
    expect(bericht.tekst).toMatch(/avond- of nachtblok/);
    expect(bericht.tekst).not.toMatch(/avonddiensten|weekenddiensten/);
    expect(period(aios.period).uitgenodigd_op).not.toBeNull();
  });

  it("sends the achterwacht's invitations to theirs", async () => {
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'OPEN' WHERE id = ?`).run(staf.period);
    try {
      const res = await invite(staf.period, staf.planner);
      expect(res.status, await res.clone().text()).toBe(200);
      await waitForMails(sink, 1);
      expect(sink.received[0].to).toEqual([AAN]);
    } finally {
      setStatus(staf.period, 'GEPUBLICEERD');
    }
  });

  it("names the own dienst's flow in a participant's swap dialog", async () => {
    const forAios = await swapContacts(req(`person/${aios.x}/swap-contacts`, 'GET', personCookie(aios.x)), ctx({ id: aios.x }));
    expect((await forAios.json()).data.planner).toBe(AAN_AIOS);
    const forStaf = await swapContacts(req(`person/${staf.x}/swap-contacts`, 'GET', personCookie(staf.x)), ctx({ id: staf.x }));
    expect((await forStaf.json()).data.planner).toBe(AAN);
  });

  it("shows a planner only the own dienst's flow address, the beheerder both", async () => {
    const zie = async (who: string) => (await (await mailSettings(req('planner/mail-settings', 'GET', staffCookie(who)))).json()).data;
    expect(await zie(staf.planner)).toMatchObject({ verzendlijst_aan: AAN, verzendlijst_aan_aios: null });
    expect(await zie(aios.planner)).toMatchObject({ verzendlijst_aan: null, verzendlijst_aan_aios: AAN_AIOS });
    expect(await zie(aios.admin)).toMatchObject({ verzendlijst_aan: AAN, verzendlijst_aan_aios: AAN_AIOS });
  });

  it("refuses an AIOS flow address that is no address, and keeps the saved one", async () => {
    const res = await saveMailSettingsRoute(
      req('planner/mail-settings', 'PUT', staffCookie(aios.admin), {
        gebruiker: 'dienstrooster.test@gmail.com',
        wachtwoord: 'abcdefghijklmnop',
        verzendlijst_aan: AAN,
        verzendlijst_aan_aios: 'geen adres',
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/van de AIOS is geen geldig e-mailadres/);
    const status = await (await mailSettings(req('planner/mail-settings', 'GET', staffCookie(aios.admin)))).json();
    expect(status.data.verzendlijst_aan_aios).toBe(AAN_AIOS);
  });

  it('"Link kwijt?" sends each flow its own verzendlijst', async () => {
    db.prepare(`UPDATE dienstrooster_schedule_period SET uitgenodigd_op = ?, basis_url = 'http://localhost' WHERE id = ?`).run(now, staf.period);
    try {
      const res = await linkAanvragen(
        new NextRequest('http://localhost/api/link-aanvragen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'iemand@example.test' }),
        })
      );
      expect(res.status, await res.clone().text()).toBe(200);
      await waitForMails(sink, 2);
      const naar = (adres: string) =>
        JSON.stringify(verzendlijstPayload(sink.received.find((m) => m.to.includes(adres))!.raw));
      expect(naar(AAN_AIOS)).toContain(aios.codenaam);
      expect(naar(AAN_AIOS)).not.toContain(staf.xCodenaam);
      expect(naar(AAN)).toContain(staf.xCodenaam);
      expect(naar(AAN)).not.toContain(aios.codenaam);
    } finally {
      db.prepare('UPDATE dienstrooster_schedule_period SET uitgenodigd_op = NULL WHERE id = ?').run(staf.period);
    }
  });

  it("keeps a swap mail of the AIOS waiting while their flow has no address, and sends the achterwacht's", async () => {
    configureSmtp(sink, { aan: AAN });
    const melding = (personId: string, periodId: string, codenaam: string) => ({
      personId,
      periodId,
      template: { naam: 'TEST', onderwerp: 'Ruil', tekst: 'Beste {{codenaam}}, {{link}}' },
      placeholders: { codenaam },
      anderen: [],
      soort: 'RUIL_UITKOMST' as const,
      linkIntro: 'Bekijk het via je persoonlijke link:',
    });
    await mailMelding(melding(aios.x, aios.period, aios.codenaam));
    const wachtend = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_mail_queue WHERE period_id = ?').get(aios.period) as { n: number }).n;
    expect(wachtend()).toBe(1);
    expect(sink.received).toHaveLength(0);

    await mailMelding(melding(staf.x, staf.period, staf.xCodenaam));
    await waitForMails(sink, 1);
    await flushMailQueue();
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].to).toEqual([AAN]);
    expect(wachtend()).toBe(1);

    // Their flow gets an address: the waiting mail goes there.
    configureSmtp(sink, { aan: AAN, aanAios: AAN_AIOS });
    await flushMailQueue();
    await waitForMails(sink, 2);
    expect(sink.received[1].to).toEqual([AAN_AIOS]);
    expect(wachtend()).toBe(0);
    expect(queuedMailCount()).toBe(0);
  });
});
