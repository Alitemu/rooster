import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstAttachment, waitForMails, type SmtpSink } from '@/tests/smtpSink';
import { POST as herinnerPerson } from '@/app/api/person/[id]/swap-requests/[swap-id]/remind/route';
import { POST as herinnerPlanner } from '@/app/api/planner/period/[id]/swap-requests/[swap-id]/remind/route';
import { GET as plannerLijst } from '@/app/api/planner/period/[id]/swap-requests/route';
import { GET as personLijst } from '@/app/api/person/[id]/swap-requests/route';
import { POST as keurGoed } from '@/app/api/person/[id]/swap-requests/[swap-id]/approve/route';
import { POST as wijsAf } from '@/app/api/person/[id]/swap-requests/[swap-id]/reject/route';
import { POST as maakAan } from '@/app/api/person/[id]/swap-requests/route';
import { POST as trekPublicatieIn } from '@/app/api/planner/period/[id]/unpublish/route';
import { mailQueueSettled } from './meldingMail';
import { ruilHerinneringMoment, stuurAutomatischeRuilHerinneringen, herinnerRuil } from './ruilHerinnering';
import { buildWorld, deleteRowsAfter, insert, now, personCookie, rowidSnapshot, staffCookie, type World } from '../tests/fixtures/dienstWorlds';

/**
 * The reminders for a swap request that waits (lib/ruilHerinnering.ts), the
 * achterwacht's:
 * - automatic, once, at the last 09:00 at or before 7 x 24 hours after the
 *   request: made on a Friday afternoon it is the next Friday morning, never
 *   the Saturday; not when it was answered or withdrawn, not after a
 *   reminder by hand, not on a voorlopig roster;
 * - two berichten and two notices in the app: the colleague is reminded
 *   (anonymous by mail), the requester is told it was done, with the advice
 *   about another day or colleague;
 * - by hand, for the requester and the planner: only after the yes, not
 *   within 24 hours of the last one, the answer says when the last one went;
 *   never someone else's request;
 * - "gelezen" for the planner: opening the list, or answering, is reading.
 */

let snapshot: Map<string, number>;
let sink: SmtpSink;
let w: World;

const cook = (id: string) => personCookie(id);
const plannerCook = () => staffCookie(w.planner);
const plus = (d: Date, uren: number) => new Date(d.getTime() + uren * 3600_000);
const statusOf = (id: string) => (db.prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?').get(id) as { status: string }).status;
const laatste = (id: string) =>
  db.prepare('SELECT laatste_herinnering_op AS op, laatste_herinnering_door AS door FROM dienstrooster_swap_request WHERE id = ?').get(id) as { op: string | null; door: string | null };
const berichten = (codenaam: string) => sink.received.flatMap((m) => verzendlijstAttachment(m.raw)).filter((b) => b.codenaam === codenaam);

/** Mails go out after the commit and are not awaited: wait until none arrive any more, so the next test starts clean. */
async function stil() {
  await mailQueueSettled();
  let n: number;
  do {
    n = sink.received.length;
    await new Promise((r) => setTimeout(r, 200));
  } while (sink.received.length !== n);
}

function vrijdagMiddag(): Date {
  const d = new Date(2098, 0, 5, 15, 0, 0);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d;
}

/** An open request from x to y for the two shifts of the world, made at `op`. */
function verzoek(op: Date): string {
  const slots = db.prepare('SELECT slot_id FROM dienstrooster_assignment WHERE schedule_version_id = ? ORDER BY slot_id').all(w.period) as Array<{ slot_id: string }>;
  const x = db.prepare('SELECT slot_id FROM dienstrooster_assignment WHERE schedule_version_id = ? AND person_id = ?').get(w.period, w.x) as { slot_id: string };
  const y = db.prepare('SELECT slot_id FROM dienstrooster_assignment WHERE schedule_version_id = ? AND person_id = ?').get(w.period, w.y) as { slot_id: string };
  expect(slots.length).toBeGreaterThan(1);
  return insert('dienstrooster_swap_request', {
    periode_id: w.period,
    aanvrager_person_id: w.x,
    aangeboden_slot_id: x.slot_id,
    gevraagde_slot_id: y.slot_id,
    respondent_person_id: w.y,
    status: 'PENDING',
    opmerkingen: 'ik heb een cursus',
    aangemaakt_op: op.toISOString(),
  });
}

// Test databases are built from migrations, which carry no notice templates. The bodies are the seeded ones.
function ensureTemplates() {
  const templates: Array<[string, string, string]> = [
    ['SWAP_REQUESTED', 'Ruilverzoek van {{aanvrager}}', 'Beste {{codenaam}},\n\n{{aanvrager}} wil een dienst met je ruilen.\n\n{{details}}\n\n{{link}}'],
    ['SWAP_RESULT', 'Je ruilverzoek is {{uitkomst}}', 'Beste {{codenaam}},\n\nJe ruilverzoek is **{{uitkomst}}**.\n\n{{details}}\n\n{{link}}'],
  ];
  for (const [sleutel, onderwerp, body] of templates) {
    if (db.prepare('SELECT 1 FROM dienstrooster_notification_template WHERE sleutel = ?').get(sleutel)) continue;
    insert('dienstrooster_notification_template', { sleutel, onderwerp, body_md: body });
  }
}

beforeAll(async () => {
  snapshot = rowidSnapshot();
  ensureTemplates();
  sink = await startSmtpSink();
  configureSmtp(sink);
  w = buildWorld('ACHTERWACHT');
  process.env.BASE_URL = 'http://localhost:3000';
  // The world's own request is not what these tests are about.
  db.prepare(`UPDATE dienstrooster_swap_request SET status = 'INGETROKKEN' WHERE id = ?`).run(w.swap);
});

afterAll(async () => {
  await stil();
  delete process.env.BASE_URL;
  clearSmtpConfig();
  await sink.close();
  db.prepare('DELETE FROM dienstrooster_mail_queue WHERE period_id = ?').run(w.period);
  deleteRowsAfter(snapshot);
});

beforeEach(async () => {
  await stil();
  sink.received.length = 0;
  db.prepare(`UPDATE dienstrooster_swap_request SET status = 'INGETROKKEN' WHERE status = 'PENDING'`).run();
  db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEPUBLICEERD', definitief_op = ? WHERE id = ?`).run(now, w.period);
});

describe('the moment', () => {
  it('the last 09:00 at or before 7 x 24 hours: a Friday afternoon is the next Friday morning, never the Saturday', () => {
    const middag = vrijdagMiddag();
    const moment = ruilHerinneringMoment(middag.toISOString());
    expect(moment.getDay()).toBe(5);
    expect([moment.getHours(), moment.getMinutes()]).toEqual([9, 0]);
    expect(moment.getTime() - middag.getTime()).toBeGreaterThan(6 * 24 * 3600_000);
    expect(moment.getTime() - middag.getTime()).toBeLessThan(7 * 24 * 3600_000);
  });

  it('made on a Friday at 08:00 the 09:00 of that day is too late: the Thursday before', () => {
    const ochtend = new Date(vrijdagMiddag());
    ochtend.setHours(8, 0, 0, 0);
    const moment = ruilHerinneringMoment(ochtend.toISOString());
    expect(moment.getDay()).toBe(4);
    expect(moment.getHours()).toBe(9);
    expect(moment.getTime() - ochtend.getTime()).toBeLessThan(7 * 24 * 3600_000);
  });

  it('across the end of a year', () => {
    const moment = ruilHerinneringMoment(new Date(2097, 11, 29, 15, 0, 0).toISOString());
    expect([moment.getFullYear(), moment.getMonth(), moment.getDate(), moment.getHours()]).toEqual([2098, 0, 5, 9]);
  });
});

describe('automatic', () => {
  it('not before the moment, then once: both are told, in the app and by mail', async () => {
    const begin = vrijdagMiddag();
    const id = verzoek(begin);
    const moment = ruilHerinneringMoment(begin.toISOString());
    expect(stuurAutomatischeRuilHerinneringen(plus(moment, -1))).toBe(0);
    expect(laatste(id).op).toBeNull();
    expect(stuurAutomatischeRuilHerinneringen(moment)).toBe(1);
    expect(laatste(id)).toEqual({ op: moment.toISOString(), door: 'AUTOMATISCH' });
    await waitForMails(sink, 2);

    const collega = berichten(w.yCodenaam).find((b) => b.soort === 'RUIL_HERINNERING')!;
    expect(collega.onderwerp).toBe('Herinnering: een ruilverzoek wacht op jouw antwoord');
    // Anonymous by mail, like the request itself.
    expect(collega.personen).toEqual([w.yCodenaam]);
    expect(collega.tekst).not.toContain(w.xCodenaam);
    expect(collega.tekst).toContain('Toelichting: ik heb een cursus');
    expect(collega.tekst).toMatch(/\/person\//);
    const aanvrager = berichten(w.xCodenaam).find((b) => b.soort === 'RUIL_HERINNERING_BEVESTIGING')!;
    expect(aanvrager.tekst).toContain('Daarom is er automatisch een herinnering gestuurd.');
    expect(aanvrager.tekst).toContain('Overweeg de dienst ook te ruilen met een andere dag of collega.');
    expect(aanvrager.tekst).toContain('Je mag meer dan één verzoek tegelijk doen.');
    expect(aanvrager.tekst).toContain('Zodra iemand de ruil accepteert, wordt het andere verzoek automatisch ingetrokken.');
    expect(aanvrager.personen).toEqual([w.xCodenaam]);

    const melding = (id2: string) =>
      (db.prepare(`SELECT onderwerp FROM dienstrooster_notification WHERE person_id = ? AND onderwerp LIKE '%herinnering%' ORDER BY aangemaakt_op`).all(id2) as Array<{ onderwerp: string }>).map((r) => r.onderwerp);
    expect(melding(w.y)).toHaveLength(1);
    expect(melding(w.x)).toContain('Er is een herinnering gestuurd voor je ruilverzoek');

    // Never a second one.
    sink.received.length = 0;
    expect(stuurAutomatischeRuilHerinneringen(plus(moment, 24 * 30))).toBe(0);
    await stil();
    expect(sink.received).toHaveLength(0);
  });

  it('not when it was answered or withdrawn, not after a reminder by hand', async () => {
    const begin = vrijdagMiddag();
    const moment = ruilHerinneringMoment(begin.toISOString());
    const beantwoord = verzoek(begin);
    db.prepare(`UPDATE dienstrooster_swap_request SET status = 'AFGEWEZEN' WHERE id = ?`).run(beantwoord);
    const terug = verzoek(begin);
    db.prepare(`UPDATE dienstrooster_swap_request SET status = 'INGETROKKEN' WHERE id = ?`).run(terug);
    const handmatig = verzoek(begin);
    db.prepare(`UPDATE dienstrooster_swap_request SET laatste_herinnering_op = ?, laatste_herinnering_door = 'AANVRAGER' WHERE id = ?`).run(plus(begin, 24).toISOString(), handmatig);
    expect(stuurAutomatischeRuilHerinneringen(plus(moment, 1))).toBe(0);
    for (const id of [beantwoord, terug]) expect(laatste(id).op).toBeNull();
    expect(laatste(handmatig).door).toBe('AANVRAGER');
    await stil();
    expect(sink.received).toHaveLength(0);
  });

  it('not on a voorlopig roster, and not for a shift that has been', async () => {
    const begin = vrijdagMiddag();
    const moment = ruilHerinneringMoment(begin.toISOString());
    const id = verzoek(begin);
    db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = NULL WHERE id = ?`).run(w.period);
    expect(stuurAutomatischeRuilHerinneringen(plus(moment, 1))).toBe(0);
    db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = ? WHERE id = ?`).run(now, w.period);
    // The shifts are in March 2098: a day later nothing is left to remind of.
    expect(stuurAutomatischeRuilHerinneringen(new Date(2098, 3, 1, 12, 0, 0))).toBe(0);
    expect(laatste(id).op).toBeNull();
    await stil();
    expect(sink.received).toHaveLength(0);
  });
});

const person = (personId: string, swapId: string, body: unknown, als = personId) =>
  herinnerPerson(
    new NextRequest(`http://localhost/api/person/${personId}/swap-requests/${swapId}/remind`, {
      method: 'POST',
      headers: { cookie: cook(als), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: personId, 'swap-id': swapId }) }
  );
const planner = (swapId: string, body: unknown, cookie = plannerCook(), periodId = w.period) =>
  herinnerPlanner(
    new NextRequest(`http://localhost/api/planner/period/${periodId}/swap-requests/${swapId}/remind`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: periodId, 'swap-id': swapId }) }
  );

describe('by hand', () => {
  it('the requester: nothing without the yes, which says there was no reminder yet; then it is sent', async () => {
    const id = verzoek(new Date());
    const zonder = await person(w.x, id, {});
    expect(zonder.status).toBe(409);
    expect(await zonder.json()).toMatchObject({ code: 'BEVESTIGING', laatste_herinnering_op: null });
    await stil();
    expect(sink.received).toHaveLength(0);
    expect(laatste(id).op).toBeNull();

    const met = await person(w.x, id, { bevestigd: true });
    expect(met.status).toBe(200);
    expect(laatste(id).door).toBe('AANVRAGER');
    await waitForMails(sink, 2);
    expect(berichten(w.yCodenaam).find((b) => b.soort === 'RUIL_HERINNERING')).toBeTruthy();
    expect(berichten(w.xCodenaam).find((b) => b.soort === 'RUIL_HERINNERING_BEVESTIGING')!.tekst).toContain('Je hebt zelf een herinnering gestuurd.');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM dienstrooster_audit_log WHERE entiteit = 'swap_request' AND entiteit_id = ? AND nieuw_json LIKE '%AANVRAGER%'`).get(id)).toEqual({ n: 1 });
  });

  it('not within 24 hours of the last one and the answer says when it went; the planner may after that', async () => {
    const id = verzoek(new Date());
    expect((await person(w.x, id, { bevestigd: true })).status).toBe(200);
    const eerst = laatste(id).op!;
    for (const res of [await person(w.x, id, { bevestigd: true }), await planner(id, { bevestigd: true })]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'TOO_SOON', laatste_herinnering_op: eerst });
    }
    // The library with a later clock: allowed again after a day.
    expect(herinnerRuil(id, 'PLANNER', w.planner, true, plus(new Date(eerst), 25))).toEqual({ ok: true, id });
    expect(laatste(id).door).toBe('PLANNER');
    await waitForMails(sink, 4);
    const bevestigingen = berichten(w.xCodenaam).filter((b) => b.soort === 'RUIL_HERINNERING_BEVESTIGING').map((b) => b.tekst);
    expect(bevestigingen.some((t) => t.includes('De planner heeft een herinnering gestuurd.'))).toBe(true);
  });

  it('only the requester for their own request; the planner of the other dienst finds nothing', async () => {
    const id = verzoek(new Date());
    // The colleague cannot press the requester's button.
    expect((await person(w.y, id, { bevestigd: true })).status).toBe(403);
    // Someone else's page is not theirs.
    expect((await person(w.x, id, { bevestigd: true }, w.y)).status).toBe(403);
    // A planner of the AIOS is refused for an achterwacht period.
    const aios = buildWorld('AIOS');
    expect((await planner(id, { bevestigd: true }, staffCookie(aios.planner))).status).toBe(404);
    // And a swap id of another period under this period's id.
    expect((await planner(aios.swap, { bevestigd: true })).status).toBe(404);
    expect(laatste(id).op).toBeNull();
  });

  it('not for a request that was answered, withdrawn, on a voorlopig roster or in the trash', async () => {
    const id = verzoek(new Date());
    db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = NULL WHERE id = ?`).run(w.period);
    const voorlopig = await person(w.x, id, { bevestigd: true });
    expect(voorlopig.status).toBe(409);
    expect((await voorlopig.json()).code).toBe('NOT_DEFINITIEF');
    db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = ? WHERE id = ?`).run(now, w.period);
    db.prepare(`UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?`).run(now, w.period);
    try {
      expect((await planner(id, { bevestigd: true })).status).toBe(409);
    } finally {
      db.prepare(`UPDATE dienstrooster_schedule_period SET verwijderd_op = NULL WHERE id = ?`).run(w.period);
    }
    db.prepare(`UPDATE dienstrooster_swap_request SET status = 'GOEDGEKEURD' WHERE id = ?`).run(id);
    const klaar = await person(w.x, id, { bevestigd: true });
    expect(klaar.status).toBe(409);
    expect((await klaar.json()).code).toBe('HANDLED');
    await stil();
    expect(sink.received).toHaveLength(0);
  });
});

describe('what the planner reads as "gelezen"', () => {
  const lijst = async () => {
    const res = await plannerLijst(new NextRequest(`http://localhost/api/planner/period/${w.period}/swap-requests`, { headers: { cookie: plannerCook() } }), {
      params: Promise.resolve({ id: w.period }),
    });
    return (await res.json()).data.swap_requests as Array<{ id: string; gelezen: boolean | null; status: string; laatste_herinnering_op: string | null }>;
  };
  const eigenLijst = (personId: string) =>
    personLijst(new NextRequest(`http://localhost/api/person/${personId}/swap-requests?period_id=${w.period}`, { headers: { cookie: cook(personId) } }), {
      params: Promise.resolve({ id: personId }),
    });
  const aanvragen = async () => {
    const slots = db.prepare('SELECT slot_id, person_id FROM dienstrooster_assignment WHERE schedule_version_id = ?').all(w.period) as Array<{ slot_id: string; person_id: string }>;
    const res = await maakAan(
      new NextRequest(`http://localhost/api/person/${w.x}/swap-requests`, {
        method: 'POST',
        headers: { cookie: cook(w.x), 'content-type': 'application/json' },
        body: JSON.stringify({
          period_id: w.period,
          offered_slot_id: slots.find((s) => s.person_id === w.x)!.slot_id,
          requested_slot_id: slots.find((s) => s.person_id === w.y)!.slot_id,
        }),
      }),
      { params: Promise.resolve({ id: w.x }) }
    );
    expect(res.status).toBe(200);
    return (await res.json()).data.swap_request_id as string;
  };

  it('not read while nobody opened it; read once the colleague opens their list', async () => {
    const id = await aanvragen();
    expect((await lijst()).find((r) => r.id === id)!.gelezen).toBe(false);
    // The requester's own list is not the colleague's reading.
    await eigenLijst(w.x);
    expect((await lijst()).find((r) => r.id === id)!.gelezen).toBe(false);
    await eigenLijst(w.y);
    expect((await lijst()).find((r) => r.id === id)!.gelezen).toBe(true);
    await stil();
  });

  it('an answered request has been read, whatever the button in the notices says: approving or rejecting counts', async () => {
    const ctx = (swap: string) => ({ params: Promise.resolve({ id: w.y, 'swap-id': swap }) });
    const req = (swap: string, soort: string, body?: unknown) =>
      new NextRequest(`http://localhost/api/person/${w.y}/swap-requests/${swap}/${soort}`, {
        method: 'POST',
        headers: { cookie: cook(w.y), 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    const af = await aanvragen();
    expect((await lijst()).find((r) => r.id === af)!.gelezen).toBe(false);
    expect((await wijsAf(req(af, 'reject', { reason: 'nee' }), ctx(af))).status).toBe(200);
    expect((await lijst()).find((r) => r.id === af)!.gelezen).toBe(true);
    expect(db.prepare('SELECT n.gelezen FROM dienstrooster_notification n JOIN dienstrooster_swap_request s ON s.melding_id = n.id WHERE s.id = ?').get(af)).toEqual({ gelezen: 1 });
    // The same swap asked again, now approved.
    const goed = await aanvragen();
    expect((await lijst()).find((r) => r.id === goed)!.gelezen).toBe(false);
    expect((await keurGoed(req(goed, 'approve'), ctx(goed))).status).toBe(200);
    expect((await lijst()).find((r) => r.id === goed)!.gelezen).toBe(true);
    expect(db.prepare('SELECT n.gelezen FROM dienstrooster_notification n JOIN dienstrooster_swap_request s ON s.melding_id = n.id WHERE s.id = ?').get(goed)).toEqual({ gelezen: 1 });
    await stil();
  });

  it('a request answered before the notice marked itself read shows as read too', async () => {
    const id = verzoek(new Date());
    db.prepare(`UPDATE dienstrooster_swap_request SET status = 'AFGEWEZEN' WHERE id = ?`).run(id);
    expect((await lijst()).find((r) => r.id === id)!.gelezen).toBe(true);
  });
});

describe('only on a definitief roster', () => {
  it('a voorlopig roster: no request and no approval, and the page says why', async () => {
    const id = verzoek(new Date());
    db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = NULL WHERE id = ?`).run(w.period);
    const slots = db.prepare('SELECT slot_id, person_id FROM dienstrooster_assignment WHERE schedule_version_id = ?').all(w.period) as Array<{ slot_id: string; person_id: string }>;
    const nieuw = await maakAan(
      new NextRequest(`http://localhost/api/person/${w.x}/swap-requests`, {
        method: 'POST',
        headers: { cookie: cook(w.x), 'content-type': 'application/json' },
        body: JSON.stringify({
          period_id: w.period,
          offered_slot_id: slots.find((s) => s.person_id === w.x)!.slot_id,
          requested_slot_id: slots.find((s) => s.person_id === w.y)!.slot_id,
        }),
      }),
      { params: Promise.resolve({ id: w.x }) }
    );
    expect(nieuw.status).toBe(403);
    expect((await nieuw.json()).error).toMatch(/^Ruilen kan pas als het rooster definitief is\. Klopt er iets niet in je voorlopige rooster\? Meld dat bij de planner\.$/);
    const ja = await keurGoed(
      new NextRequest(`http://localhost/api/person/${w.y}/swap-requests/${id}/approve`, { method: 'POST', headers: { cookie: cook(w.y) } }),
      { params: Promise.resolve({ id: w.y, 'swap-id': id }) }
    );
    expect(ja.status).toBe(403);
    expect(statusOf(id)).toBe('PENDING');
  });
});

describe('withdrawn when the roster changes', () => {
  it('taking the publication back withdraws every open request and tells both sides, anonymous', async () => {
    const id = verzoek(new Date());
    const res = await trekPublicatieIn(
      new NextRequest(`http://localhost/api/planner/period/${w.period}/unpublish`, { method: 'POST', headers: { cookie: plannerCook(), 'content-type': 'application/json' }, body: '{}' }),
      { params: Promise.resolve({ id: w.period }) }
    );
    expect(res.status).toBe(200);
    expect(statusOf(id)).toBe('INGETROKKEN');
    expect((db.prepare('SELECT reden_afwijzing FROM dienstrooster_swap_request WHERE id = ?').get(id) as { reden_afwijzing: string }).reden_afwijzing).toBe('Het rooster is aangepast.');
    await waitForMails(sink, 2);
    const aanColl = berichten(w.yCodenaam).find((b) => b.soort === 'RUIL_INGETROKKEN')!;
    expect(aanColl.tekst).toContain('Het rooster is aangepast.');
    expect(aanColl.personen).toEqual([w.yCodenaam]);
    const aanAanvrager = berichten(w.xCodenaam).find((b) => b.soort === 'RUIL_UITKOMST')!;
    expect(aanAanvrager.tekst).toContain('Het rooster is aangepast.');
    expect(aanAanvrager.tekst).not.toContain(w.yCodenaam);
    await stil();
  });

  it('a dienst that went to someone else by hand withdraws the requests about it, and only those', async () => {
    const een = verzoek(new Date());
    const x = db.prepare('SELECT id, person_id FROM dienstrooster_assignment WHERE schedule_version_id = ? AND person_id = ?').get(w.period, w.x) as { id: string };
    const { closeSwapsAfterRosterChange } = await import('./swapLifecycle');
    // Nothing moved: nothing withdrawn.
    expect(db.transaction(() => closeSwapsAfterRosterChange(w.period, new Date().toISOString()).aantal)()).toBe(0);
    expect(statusOf(een)).toBe('PENDING');
    // The planner gave x's dienst to y: the request can never be approved.
    db.prepare('UPDATE dienstrooster_assignment SET person_id = ? WHERE id = ?').run(w.y, x.id);
    const gesloten = db.transaction(() => closeSwapsAfterRosterChange(w.period, new Date().toISOString()))();
    gesloten.meldingen.forEach((m) => m.send());
    expect(gesloten.aantal).toBe(1);
    expect(statusOf(een)).toBe('INGETROKKEN');
    await waitForMails(sink, 2);
    db.prepare('UPDATE dienstrooster_assignment SET person_id = ? WHERE id = ?').run(w.x, x.id);
    await stil();
  });
});
