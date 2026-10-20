import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { bewaarAiosStroomAdres } from '@/lib/aiosMail';
import { runAutoReminders } from '@/lib/autoReminders';
import { reminderMoment } from '@/lib/aiosAutoHerinneringen';
import { linkAanvraagKandidaten } from '@/lib/linkAanvraag';
import { purgePeriodNow, softDeletePeriod } from '@/lib/periodTrash';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, waitForMails, type SmtpSink } from '@/tests/smtpSink';
import { POST as achterwachtOpen } from '../periods/[id]/open/route';
import { POST as achterwachtAfwezigheid } from '../person/[id]/absences/route';
import { POST as lidToevoegen } from '../planner/pool/[id]/members/route';
import { PATCH as lidWijzigen } from '../planner/pool/[id]/members/[membershipId]/route';
import { GET as periode } from './periode/[id]/route';
import { POST as openen } from './periode/[id]/openen/route';
import { PATCH as deadline } from './periode/[id]/deadline/route';
import { POST as sluiten } from './periode/[id]/sluiten/route';
import { POST as heropenen } from './periode/[id]/heropenen/route';
import { POST as uitnodigingen } from './periode/[id]/uitnodigingen/route';
import { POST as links } from './periode/[id]/links/route';
import { POST as herinneringen } from './periode/[id]/herinneringen/route';
import { GET as voorkeuren } from './periode/[id]/voorkeuren/route';
import { GET as mailGet, PUT as mailPut } from './mail-instellingen/route';
import { POST as linkAanvragen } from './link-aanvragen/route';
import { POST as afwezigheid } from './deelnemer/[id]/afwezigheid/route';
import { POST as deeltijd } from './deelnemer/[id]/deeltijd/route';
import {
  answerText,
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
} from '../../../tests/fixtures/dienstWorlds';

/**
 * The AIOS has its own code, the achterwacht's stays as it is
 * (docs/development/diensten.md, "Copied, not changed"). Two halves:
 *
 * - the AIOS's own routes (app/api/aios) take an AIOS quarter from opening
 *   to closing: the deadline before the quarter, someone taking part, leave
 *   and part-time days marked by the AIOS's rules, invitations and
 *   reminders to the AIOS's own flow with their own text and links, the
 *   flow address for the beheerder only, "Link kwijt?", the status;
 * - the achterwacht's code, unchanged, leaves an open AIOS period alone:
 *   its opening refuses it, its automatic reminders and its "Link kwijt?"
 *   never pick it up, its absence route does not write into it, and its
 *   prullenbak takes the AIOS's rows with the period.
 */

const AAN = 'stroom@example.test';
const AAN_AIOS = 'stroom-aios@example.test';

let snapshot: Map<string, number>;
let sink: SmtpSink;
let staf: World;
const aios = {} as { pool: string; period: string; planner: string; admin: string; x: string; y: string; codenaam: string; start: string };

const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });

function req(url: string, method: string, cookie: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const rij = (id: string) =>
  db.prepare('SELECT status, deadline, bevroren_ruleset_json, auto_herinneren, uitgenodigd_op FROM dienstrooster_schedule_period WHERE id = ?').get(id) as {
    status: string;
    deadline: string;
    bevroren_ruleset_json: string | null;
    auto_herinneren: number;
    uitgenodigd_op: string | null;
  };

const bij = (route: (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>, stap: string, method: string, body?: unknown, who = aios.planner) =>
  route(req(`aios/periode/${aios.period}/${stap}`, method, staffCookie(who), body), ctx({ id: aios.period }));

/** The levels on one person's slots of a period, by dienst code. */
function markeringen(personId: string, bron: string): Array<{ code: string; level: string }> {
  return db
    .prepare(
      `SELECT DISTINCT st.code, av.blocking_level AS level FROM dienstrooster_availability av
       JOIN dienstrooster_shift_slot s ON s.id = av.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE av.person_id = ? AND s.period_id = ? AND av.source = ? ORDER BY st.code, av.blocking_level`
    )
    .all(personId, aios.period, bron) as Array<{ code: string; level: string }>;
}

beforeAll(async () => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  aios.planner = staff('PLANNER', 'AIOS');
  aios.admin = staff('ADMIN', 'ACHTERWACHT');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosApart-${tag}`, config_json: '{}', aangemaakt_op: now });
  aios.pool = insert('dienstrooster_pool', { naam: `AiosApart-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, aios.pool);
  // 2097 Q2: with Easter Monday, Koningsdag and Hemelvaart in it.
  const q = aiosQuarter(2097, 2);
  aios.start = q.start_datum;
  aios.period = insert('dienstrooster_schedule_period', {
    pool_id: aios.pool,
    naam: `AiosApart-${tag}`,
    start_datum: q.start_datum,
    eind_datum: q.eind_datum,
    deadline: '2097-02-10T17:00',
    status: 'CONCEPT',
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(aios.period, aiosShiftTypes(aios.pool)!, q.start_datum, q.eind_datum))();
  const deelnemer = (naam: string) => {
    const id = insert('dienstrooster_person', { codenaam: `aiosapart-${naam}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_person_access_link', { person_id: id, token_hash: `aiosapart-${naam}-${tag}`, aangemaakt_op: now });
    return id;
  };
  aios.x = deelnemer('x');
  aios.y = deelnemer('y');
  aios.codenaam = `aiosapart-x-${tag}`;
  // Leave over a weekday and Koningsdag, and a part-time Monday, entered before the period opens.
  insert('dienstrooster_absence', { person_id: aios.x, van_datum: '2097-04-26', tot_datum: '2097-04-27', soort: 'VAKANTIE', aangemaakt_door: aios.x, aangemaakt_op: now });
  insert('dienstrooster_parttime_pattern', { person_id: aios.y, weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2097-01-01', geldig_tot: '2097-12-31', aangemaakt_door: aios.y, aangemaakt_op: now });
  sink = await startSmtpSink();
});

afterAll(async () => {
  bewaarAiosStroomAdres('', aios.admin);
  clearSmtpConfig();
  delete process.env.BASE_URL;
  await sink.close();
  deleteRowsAfter(snapshot);
});

beforeEach(() => {
  sink.received.length = 0;
});

describe('opening an AIOS period, on its own route', () => {
  it('refuses while no AIOS takes part', async () => {
    const res = await bij(openen, 'openen', 'POST', {});
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Er doet nog geen AIOS mee/);
    expect(rij(aios.period).status).toBe('CONCEPT');
  });

  it('refuses a deadline in the past, on or after the start, or no date', async () => {
    for (const p of [aios.x, aios.y]) {
      insert('dienstrooster_pool_membership', { person_id: p, pool_id: aios.pool, deelnamefactor: 1, geldig_vanaf: '2096-01-01', geldig_tot: '2098-12-31' });
    }
    for (const d of ['2020-01-01T17:00', `${aios.start}T00:00`, 'morgen', 12]) {
      const res = await bij(openen, 'openen', 'POST', { deadline: d });
      expect(res.status, String(d)).toBe(400);
    }
    expect(rij(aios.period).status).toBe('CONCEPT');
  });

  it("is refused by the achterwacht's opening, which stays as it was", async () => {
    const res = await achterwachtOpen(req(`periods/${aios.period}/open`, 'POST', staffCookie(aios.admin), { deadline: '2097-02-11T17:00' }), ctx({ id: aios.period }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('AIOS_NOG_NIET');
  });

  it('opens with only a deadline: no ruleset, automatic reminders of the achterwacht off, leave and part-time days marked', async () => {
    const res = await bij(openen, 'openen', 'POST', { deadline: '2097-02-11T17:00' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(rij(aios.period)).toMatchObject({ status: 'OPEN', deadline: '2097-02-11T17:00', bevroren_ruleset_json: null, auto_herinneren: 0 });
    // Leave: blocked, on Koningsdag liever niet.
    const verlof = markeringen(aios.x, 'ABSENCE');
    expect(verlof.filter((m) => m.level === 'LIEVER_NIET').length).toBeGreaterThan(0);
    expect(verlof.filter((m) => m.level === 'ABSOLUUT').length).toBeGreaterThan(0);
    // A part-time Monday: the uitloopdienst blocked, the evening (on Easter
    // Monday the weekend evening) liever niet, not the day nor the night.
    const pt = markeringen(aios.y, 'PARTTIME');
    expect([...new Set(pt.map((m) => `${m.code} ${m.level}`))].sort()).toEqual(['AD LIEVER_NIET', 'ADW LIEVER_NIET', 'UD ABSOLUUT']);
  });

  it('opens only once, and an AIOS route takes no achterwacht period', async () => {
    expect((await bij(openen, 'openen', 'POST', {})).status).toBe(400);
    const res = await openen(req(`aios/periode/${staf.period}/openen`, 'POST', staffCookie(aios.admin), {}), ctx({ id: staf.period }));
    expect(res.status).toBe(404);
    // Not even read, and no links minted for the achterwacht's participants.
    expect((await periode(req(`aios/periode/${staf.period}`, 'GET', staffCookie(aios.admin)), ctx({ id: staf.period }))).status).toBe(404);
    expect((await links(req(`aios/periode/${staf.period}/links`, 'POST', staffCookie(aios.admin)), ctx({ id: staf.period }))).status).toBe(404);
  });
});

describe('leave and part-time days of an AIOS', () => {
  it('reach the AIOS period through their own routes, by the AIOS rules', async () => {
    const res = await afwezigheid(
      req(`aios/deelnemer/${aios.y}/afwezigheid`, 'POST', personCookie(aios.y), { van_datum: '2097-05-06', tot_datum: '2097-05-06', soort: 'CONGRES' }),
      ctx({ id: aios.y })
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect([...new Set(markeringen(aios.y, 'ABSENCE').map((m) => m.level))]).toEqual(['ABSOLUUT']);
    const dt = await deeltijd(
      req(`aios/deelnemer/${aios.x}/deeltijd`, 'POST', personCookie(aios.x), { weekdag: 'DO', frequentie: 'ELKE_WEEK', geldig_vanaf: '2097-01-01', geldig_tot: '2097-12-31' }),
      ctx({ id: aios.x })
    );
    expect(dt.status, await dt.clone().text()).toBe(201);
    expect(markeringen(aios.x, 'PARTTIME').length).toBeGreaterThan(0);
  });

  it("are refused by the achterwacht's absence route: it has only the achterwacht's sync", async () => {
    const voor = markeringen(aios.y, 'ABSENCE').length;
    for (const cookie of [personCookie(aios.y), staffCookie(aios.planner), staffCookie(aios.admin)]) {
      const res = await achterwachtAfwezigheid(
        req(`person/${aios.y}/absences`, 'POST', cookie, { van_datum: '2097-06-03', tot_datum: '2097-06-03', soort: 'VAKANTIE' }),
        ctx({ id: aios.y })
      );
      expect(res.status).toBe(404);
    }
    expect(db.prepare("SELECT 1 FROM dienstrooster_absence WHERE person_id = ? AND van_datum = '2097-06-03'").get(aios.y)).toBeUndefined();
    expect(markeringen(aios.y, 'ABSENCE').length).toBe(voor);
  });

  it('reach the open AIOS period when the AIOS planner adds an AIOS to the pool or extends Geldig tot', async () => {
    // Part-time days from before: z was in the pool earlier, w's Geldig tot ends before the quarter.
    const nieuw = (naam: string) => {
      const id = insert('dienstrooster_person', { codenaam: `aiosapart-${naam}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
      insert('dienstrooster_parttime_pattern', { person_id: id, weekdag: 'WO', frequentie: 'ELKE_WEEK', geldig_vanaf: '2097-01-01', geldig_tot: '2097-12-31', aangemaakt_door: id, aangemaakt_op: now });
      return id;
    };
    const z = nieuw('z');
    const w = nieuw('w');
    const lid = insert('dienstrooster_pool_membership', { person_id: w, pool_id: aios.pool, deelnamefactor: 1, geldig_vanaf: '2096-01-01', geldig_tot: '2097-01-31' });
    expect(markeringen(z, 'PARTTIME')).toEqual([]);
    const toegevoegd = await lidToevoegen(
      req(`planner/pool/${aios.pool}/members`, 'POST', staffCookie(aios.planner), { codenaam: `aiosapart-z-${tag}`, geldig_vanaf: '2097-01-01', geldig_tot: '2097-12-31' }),
      ctx({ id: aios.pool })
    );
    expect(toegevoegd.status, await toegevoegd.clone().text()).toBe(201);
    expect(markeringen(z, 'PARTTIME').length).toBeGreaterThan(0);
    expect(markeringen(w, 'PARTTIME')).toEqual([]);
    const verlengd = await lidWijzigen(
      req(`planner/pool/${aios.pool}/members/${lid}`, 'PATCH', staffCookie(aios.planner), { geldig_tot: '2097-12-31' }),
      { params: Promise.resolve({ id: aios.pool, membershipId: lid }) }
    );
    expect(verlengd.status, await verlengd.clone().text()).toBe(200);
    expect(markeringen(w, 'PARTTIME').length).toBeGreaterThan(0);
    // Out of the pool again: the tests below count x and y.
    for (const p of [z, w]) {
      db.prepare('DELETE FROM dienstrooster_availability WHERE person_id = ?').run(p);
      db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(p);
    }
  });
});

describe("the AIOS's mail goes to their own flow", () => {
  it('sends no invitation while their flow has no address, and issues no links', async () => {
    configureSmtp(sink, { aan: AAN });
    const aantalLinks = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').get(aios.period) as { n: number }).n;
    const voor = aantalLinks();
    const res = await bij(uitnodigingen, 'uitnodigingen', 'POST', {});
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NOT_CONFIGURED');
    expect(aantalLinks()).toBe(voor);
    expect(sink.received).toHaveLength(0);
  });

  it("keeps the AIOS's flow address for the beheerder, and hides it from the achterwacht's planner", async () => {
    expect((await mailPut(req('aios/mail-instellingen', 'PUT', staffCookie(aios.planner), { verzendlijst_aan: AAN_AIOS }))).status).toBe(403);
    const fout = await mailPut(req('aios/mail-instellingen', 'PUT', staffCookie(aios.admin), { verzendlijst_aan: 'geen adres' }));
    expect(fout.status).toBe(400);
    const goed = await mailPut(req('aios/mail-instellingen', 'PUT', staffCookie(aios.admin), { verzendlijst_aan: AAN_AIOS }));
    expect(goed.status).toBe(200);
    expect((await (await mailGet(req('aios/mail-instellingen', 'GET', staffCookie(aios.planner)))).json()).data).toMatchObject({
      ingesteld: true,
      verzendlijst_aan: AAN_AIOS,
    });
    expect((await mailGet(req('aios/mail-instellingen', 'GET', staffCookie(staf.planner)))).status).toBe(404);
  });

  it("sends the invitations to the AIOS's flow with their text and /aios/ links, and leaves uitgenodigd_op alone", async () => {
    const res = await bij(uitnodigingen, 'uitnodigingen', 'POST', {});
    expect(res.status, await res.clone().text()).toBe(200);
    await waitForMails(sink, 1);
    expect(sink.received[0].to).toEqual([AAN_AIOS]);
    expect(verzendlijstPayload(sink.received[0].raw).dienst).toBe('AIOS');
    const bericht = verzendlijstPayload(sink.received[0].raw).berichten.find((b) => b.codenaam === aios.codenaam)!;
    expect(bericht.tekst).toMatch(/Het rooster van de AIOS voor/);
    expect(bericht.tekst).toMatch(/\/aios\/[A-Za-z0-9_-]+/);
    expect(bericht.tekst).not.toMatch(/\/person\//);
    // The achterwacht's active period, its "Link kwijt?" and its reminders run over uitgenodigd_op.
    expect(rij(aios.period).uitgenodigd_op).toBeNull();
    const stand = await (await periode(req(`aios/periode/${aios.period}`, 'GET', staffCookie(aios.planner)), ctx({ id: aios.period }))).json();
    expect(stand.data.uitgenodigd_op).not.toBeNull();
  });

  it('reminds those who have not handed in, once a day unless asked again', async () => {
    const eerst = await bij(herinneringen, 'herinneringen', 'POST', {});
    expect(eerst.status, await eerst.clone().text()).toBe(200);
    expect((await eerst.json()).data.aantal).toBe(2);
    await waitForMails(sink, 1);
    expect(sink.received[0].to).toEqual([AAN_AIOS]);
    const nogmaals = await bij(herinneringen, 'herinneringen', 'POST', {});
    expect((await nogmaals.json()).data).toMatchObject({ aantal: 0, overgeslagen: 2 });
    const opnieuw = await bij(herinneringen, 'herinneringen', 'POST', { opnieuw: true, person_id: aios.x });
    expect((await opnieuw.json()).data.aantal).toBe(1);
  });

  it('downloads the links to the AIOS page', async () => {
    const res = await bij(links, 'links', 'POST');
    expect(res.status).toBe(200);
    const tekst = await answerText(res);
    expect(tekst).toContain(aios.codenaam);
    expect(tekst).toMatch(/\/aios\//);
  });

  it('"Link kwijt?" sends the AIOS\'s flow the AIOS\'s links, and the achterwacht\'s holds none of them', async () => {
    const res = await linkAanvragen(
      new NextRequest('http://localhost/api/aios/link-aanvragen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'iemand@example.test' }),
      })
    );
    expect(res.status, await res.clone().text()).toBe(200);
    await waitForMails(sink, 1);
    expect(sink.received[0].to).toEqual([AAN_AIOS]);
    expect(verzendlijstPayload(sink.received[0].raw).dienst).toBe('AIOS');
    const lijst = JSON.stringify(verzendlijstPayload(sink.received[0].raw));
    expect(lijst).toContain(aios.codenaam);
    expect(lijst).not.toContain(staf.xCodenaam);
    expect(JSON.stringify(linkAanvraagKandidaten())).not.toContain(aios.codenaam);
  });

  it("is never sent by the achterwacht's automatic reminders, though a reminder moment is due", async () => {
    process.env.BASE_URL = 'http://localhost';
    try {
      const moment = new Date(reminderMoment(new Date('2097-02-11T17:00'), 7).getTime() + 60 * 60 * 1000);
      const result = await runAutoReminders(moment, { onlyPeriodIds: [aios.period] });
      expect(result).toEqual([]);
      expect(sink.received).toHaveLength(0);
    } finally {
      delete process.env.BASE_URL;
    }
  });
});

describe('"Status voorkeuren" and the steps after opening', () => {
  it('lists each AIOS taking part, for the AIOS planner only', async () => {
    const res = await voorkeuren(req(`aios/periode/${aios.period}/voorkeuren`, 'GET', staffCookie(aios.planner)), ctx({ id: aios.period }));
    expect(res.status).toBe(200);
    const { deelnemers } = (await res.json()).data;
    expect(deelnemers.map((d: { codenaam: string }) => d.codenaam).sort()).toEqual([aios.codenaam, `aiosapart-y-${tag}`].sort());
    expect((await voorkeuren(req(`aios/periode/${aios.period}/voorkeuren`, 'GET', staffCookie(staf.planner)), ctx({ id: aios.period }))).status).toBe(404);
  });

  it('moves the deadline, closes and opens again', async () => {
    expect((await bij(deadline, 'deadline', 'PATCH', { deadline: `${aios.start}T08:00` })).status).toBe(400);
    expect((await bij(deadline, 'deadline', 'PATCH', { deadline: '2097-02-12T17:00' })).status).toBe(200);
    expect(rij(aios.period).deadline).toBe('2097-02-12T17:00');
    expect((await bij(heropenen, 'heropenen', 'POST')).status).toBe(409);
    expect((await bij(sluiten, 'sluiten', 'POST')).status).toBe(200);
    expect(rij(aios.period).status).toBe('GESLOTEN');
    expect((await bij(deadline, 'deadline', 'PATCH', { deadline: '2097-02-13T17:00' })).status).toBe(400);
    expect((await bij(heropenen, 'heropenen', 'POST')).status).toBe(200);
    expect(rij(aios.period)).toMatchObject({ status: 'OPEN', auto_herinneren: 0 });
  });

  it("goes with its AIOS rows when the achterwacht's prullenbak purges it", () => {
    insert('dienstrooster_aios_wens', { period_id: aios.period, person_id: aios.x, gewijzigd_op: now });
    // What the later steps keep with a period: a block choice, a roster with a change by hand,
    // the solver's share, a swap request and the voortgangstoets (0.76.0 to 0.82.0).
    const blok = (db.prepare('SELECT id FROM dienstrooster_shift_block WHERE period_id = ? LIMIT 1').get(aios.period) as { id: string }).id;
    const slot = (db.prepare('SELECT id FROM dienstrooster_shift_slot WHERE period_id = ? LIMIT 1').get(aios.period) as { id: string }).id;
    insert('dienstrooster_aios_blokkeuze', { period_id: aios.period, blok_id: blok, opknippen: 1, gekozen_op: now });
    const toewijzing = insert('dienstrooster_assignment', { schedule_version_id: aios.period, person_id: aios.x, slot_id: slot, bron: 'MANUAL', row_version: 1, aangemaakt_op: now });
    insert('dienstrooster_assignment_edit', {
      toewijzing_id: toewijzing,
      periode_id: aios.period,
      person_id: aios.x,
      slot_id: slot,
      edit_type: 'RUIL',
      reden: 'ruil tussen AIOS',
      bewerkt_door_person_id: aios.x,
      aangemaakt_op: now,
      row_version: 1,
    });
    insert('dienstrooster_aios_doel', { period_id: aios.period, person_id: aios.x, doel_punten: 10, doel_feestdagen: 1 });
    insert('dienstrooster_aios_ruil', {
      period_id: aios.period,
      aanvrager_id: aios.x,
      respondent_id: aios.y,
      aangeboden_json: JSON.stringify([slot]),
      gevraagd_json: '[]',
      status: 'IN_BEHANDELING',
      aangemaakt_op: now,
    });
    db.prepare('UPDATE dienstrooster_aios_periode SET voortgangstoets = ? WHERE period_id = ?').run('2097-02-25', aios.period);
    softDeletePeriod(aios.period, aios.admin);
    purgePeriodNow(aios.period, aios.admin);
    expect(db.prepare('SELECT 1 FROM dienstrooster_schedule_period WHERE id = ?').get(aios.period)).toBeUndefined();
    for (const tabel of ['dienstrooster_aios_wens', 'dienstrooster_aios_periode', 'dienstrooster_aios_blokkeuze', 'dienstrooster_aios_doel', 'dienstrooster_aios_ruil']) {
      expect(db.prepare(`SELECT 1 FROM ${tabel} WHERE period_id = ?`).get(aios.period), tabel).toBeUndefined();
    }
    expect(db.prepare('SELECT 1 FROM dienstrooster_assignment_edit WHERE periode_id = ?').get(aios.period)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM dienstrooster_shift_block WHERE period_id = ?').get(aios.period)).toBeUndefined();
  });
});
