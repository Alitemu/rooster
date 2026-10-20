import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { bewaarAiosStroomAdres } from '@/lib/aiosMail';
import { aiosPersoonlijkeLink, aiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { aiosRuilHerinneringMoment, stuurAutomatischeAiosRuilHerinneringen, vraagAiosRuilAan, keurAiosRuilGoed, wijsAiosRuilAf, trekAiosRuilIn } from '@/lib/aiosRuilen';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, waitForMails, type SmtpSink } from '@/tests/smtpSink';
import { POST as herinnerDeelnemer } from './deelnemer/[id]/periode/[periodId]/ruilen/[ruilId]/herinneren/route';
import { POST as herinnerPlanner } from './periode/[id]/ruilen/[ruilId]/herinneren/route';
import { buildWorld, deleteRowsAfter, insert, now, personCookie, rowidSnapshot, staff, staffCookie, tag, type World } from '../../../tests/fixtures/dienstWorlds';

/**
 * The reminders for an AIOS's open swap request (lib/aiosRuilen.ts):
 * - automatic, once, at the last 09:00 at or before 7 x 24 hours after the
 *   request: made on a Friday afternoon it is the next Friday morning, never
 *   the Saturday; not when it was answered or taken back, not after a
 *   reminder by hand, not on a voorlopig roster;
 * - two berichten: the colleague is reminded (anonymous), the requester is
 *   told it was done, with the advice about another day or colleague;
 * - by hand, for the requester and the planner: only after the yes, not
 *   within 24 hours of the last one, the answer says when the last one went;
 *   nobody else's request, nothing across the two diensten.
 */

const AAN_AIOS = 'stroom-aios-herinnering@example.test';
const START = '2094-07-07';
const EIND = '2094-10-05';

let snapshot: Map<string, number>;
let staf: World;
let sink: SmtpSink;
const w = {} as { pool: string; period: string; planner: string; x: string; y: string; z: string };
const cn = (n: string) => `aiosherinner-${n}-${tag}`;
const XD = ['2094-08-10', '2094-08-17', '2094-08-24', '2094-08-31'];
const YD = ['2094-09-01', '2094-09-08', '2094-09-15', '2094-09-22'];
const ZD = ['2094-08-12', '2094-08-19', '2094-08-26', '2094-09-02'];
const slot = (code: string, datum: string) =>
  (db
    .prepare(
      `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND st.code = ? AND sl.datum = ?`
    )
    .get(w.period, code, datum) as { id: string }).id;
const geef = (id: string, wie: string) =>
  insert('dienstrooster_assignment', { schedule_version_id: w.period, person_id: wie, slot_id: id, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
const periode = () => aiosUitnodigPeriode(w.period)!;
const laatste = (id: string) =>
  db.prepare('SELECT laatste_herinnering_op AS op, laatste_herinnering_door AS door FROM dienstrooster_aios_ruil WHERE id = ?').get(id) as { op: string | null; door: string | null };

// A Friday afternoon well before the diensten (they start on 10 augustus): found by looking, not assumed.
function vrijdagMiddag(): Date {
  const d = new Date(2094, 6, 12, 15, 0, 0);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d;
}
const plus = (d: Date, uren: number) => new Date(d.getTime() + uren * 3600_000);

/** A request of x to y for two uitloopdiensten of their own, made at `op`. */
function verzoek(van: string, _naar: string, ux: string, uy: string, op: Date): string {
  const r = vraagAiosRuilAan(periode(), van, `dienst:${ux}`, `dienst:${uy}`, 'ik heb een cursus', op);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return (r as { id: string }).id;
}

beforeAll(async () => {
  snapshot = rowidSnapshot();
  sink = await startSmtpSink();
  configureSmtp(sink, { aan: 'stroom@example.test' });
  staf = buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  bewaarAiosStroomAdres(AAN_AIOS, w.planner);
  process.env.BASE_URL = 'http://localhost:3000';
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosHer-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosHer-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  w.period = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `AiosHer-${tag}`,
    start_datum: START,
    eind_datum: EIND,
    deadline: '2094-05-01T17:00',
    status: 'GEPUBLICEERD',
    definitief_op: now,
    auto_herinneren: 0,
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(w.period, aiosShiftTypes(w.pool)!, START, EIND))();
  const deelnemer = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: cn(n), rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    aiosPersoonlijkeLink(id, w.period, 'http://localhost:3000');
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
  w.z = deelnemer('z');
  // Uitloopdiensten, a week apart (all Tuesdays, Wednesdays and Thursdays): x, y and z each four.
  XD.forEach((d) => geef(slot('UD', d), w.x));
  YD.forEach((d) => geef(slot('UD', d), w.y));
  ZD.forEach((d) => geef(slot('UD', d), w.z));
});

afterAll(async () => {
  delete process.env.BASE_URL;
  bewaarAiosStroomAdres('', w.planner);
  clearSmtpConfig();
  await sink.close();
  deleteRowsAfter(snapshot);
});

/** Mails go out after the commit and are not awaited: wait until none arrive any more, so the next test starts clean. */
async function stil() {
  let n: number;
  do {
    n = sink.received.length;
    await new Promise((r) => setTimeout(r, 250));
  } while (sink.received.length !== n);
}

beforeEach(async () => {
  await stil();
  sink.received.length = 0;
});

afterAll(stil);

const x = (i: number) => slot('UD', XD[i]);
const y = (i: number) => slot('UD', YD[i]);
const z = (i: number) => slot('UD', ZD[i]);

describe('the moment', () => {
  it('the last 09:00 at or before 7 x 24 hours: a Friday afternoon is the next Friday morning, never the Saturday', () => {
    const middag = vrijdagMiddag();
    const moment = aiosRuilHerinneringMoment(middag.toISOString());
    expect(moment.getDay()).toBe(5);
    expect([moment.getHours(), moment.getMinutes()]).toEqual([9, 0]);
    expect(moment.getTime() - middag.getTime()).toBeGreaterThan(6 * 24 * 3600_000);
    expect(moment.getTime() - middag.getTime()).toBeLessThan(7 * 24 * 3600_000);
  });

  it('made on a Friday at 08:00 the 09:00 of that day is too late: the Thursday before', () => {
    const ochtend = new Date(vrijdagMiddag());
    ochtend.setHours(8, 0, 0, 0);
    const moment = aiosRuilHerinneringMoment(ochtend.toISOString());
    expect(moment.getDay()).toBe(4);
    expect(moment.getHours()).toBe(9);
    expect(moment.getTime() - ochtend.getTime()).toBeGreaterThan(6 * 24 * 3600_000);
    expect(moment.getTime() - ochtend.getTime()).toBeLessThan(7 * 24 * 3600_000);
  });

  it('across the end of a year', () => {
    const moment = aiosRuilHerinneringMoment(new Date(2093, 11, 29, 15, 0, 0).toISOString());
    expect([moment.getFullYear(), moment.getMonth(), moment.getDate(), moment.getHours()]).toEqual([2094, 0, 5, 9]);
  });
});

describe('automatic', () => {
  it('not before the moment, then once: the colleague is reminded, the requester is told', async () => {
    const begin = vrijdagMiddag();
    const id = verzoek(w.x, w.y, x(0), y(0), begin);
    const moment = aiosRuilHerinneringMoment(begin.toISOString());
    await waitForMails(sink, 2);
    sink.received.length = 0;

    expect(stuurAutomatischeAiosRuilHerinneringen(plus(moment, -1))).toBe(0);
    expect(laatste(id).op).toBeNull();
    expect(stuurAutomatischeAiosRuilHerinneringen(moment)).toBe(1);
    expect(laatste(id)).toEqual({ op: moment.toISOString(), door: 'AUTOMATISCH' });
    await waitForMails(sink, 2);
    const berichten = sink.received.map((m) => verzendlijstPayload(m.raw).berichten[0]);
    const collega = berichten.find((b) => b.soort === 'RUIL_HERINNERING')!;
    expect(collega.codenaam).toBe(cn('y'));
    // Anonymous, like the request.
    expect(collega.personen).toEqual([cn('y')]);
    expect(collega.tekst).not.toContain(cn('x'));
    expect(collega.tekst).toContain('Toelichting: ik heb een cursus');
    const aanvrager = berichten.find((b) => b.soort === 'RUIL_HERINNERING_BEVESTIGING')!;
    expect(aanvrager.codenaam).toBe(cn('x'));
    expect(aanvrager.tekst).toContain('Daarom is er automatisch een herinnering gestuurd.');
    expect(aanvrager.tekst).toContain('Overweeg de dienst ook te ruilen met een andere dag of collega.');
    expect(aanvrager.tekst).toContain('Je mag meer dan één verzoek tegelijk doen.');
    expect(aanvrager.tekst).toContain('Zodra iemand de ruil accepteert, wordt het andere verzoek automatisch ingetrokken.');

    // Never a second one.
    sink.received.length = 0;
    expect(stuurAutomatischeAiosRuilHerinneringen(plus(moment, 24 * 30))).toBe(0);
    expect(sink.received).toHaveLength(0);
    trekAiosRuilIn(periode(), w.x, id, plus(moment, 1));
  });

  it('not when it was answered or taken back before the moment', async () => {
    const begin = vrijdagMiddag();
    const moment = aiosRuilHerinneringMoment(begin.toISOString());
    const goed = verzoek(w.x, w.y, x(1), y(1), begin);
    const af = verzoek(w.x, w.z, x(2), z(0), begin);
    const terug = verzoek(w.y, w.z, y(2), z(1), begin);
    expect(keurAiosRuilGoed(periode(), w.y, goed, plus(begin, 24)).ok).toBe(true);
    expect(wijsAiosRuilAf(periode(), w.z, af, 'nee', plus(begin, 24)).ok).toBe(true);
    expect(trekAiosRuilIn(periode(), w.y, terug, plus(begin, 24)).ok).toBe(true);
    await waitForMails(sink, 11);
    sink.received.length = 0;
    expect(stuurAutomatischeAiosRuilHerinneringen(plus(moment, 1))).toBe(0);
    for (const id of [goed, af, terug]) expect(laatste(id).op).toBeNull();
    expect(sink.received).toHaveLength(0);
  });

  it('not after a reminder by hand, not for a dienst that has been, not on a voorlopig roster', async () => {
    const begin = vrijdagMiddag();
    const moment = aiosRuilHerinneringMoment(begin.toISOString());
    const handmatig = verzoek(w.x, w.y, x(3), y(3), begin);
    db.prepare(`UPDATE dienstrooster_aios_ruil SET laatste_herinnering_op = ?, laatste_herinnering_door = 'AANVRAGER' WHERE id = ?`).run(plus(begin, 24).toISOString(), handmatig);
    expect(stuurAutomatischeAiosRuilHerinneringen(plus(moment, 1))).toBe(0);
    db.prepare(`UPDATE dienstrooster_aios_ruil SET laatste_herinnering_op = NULL, laatste_herinnering_door = NULL WHERE id = ?`).run(handmatig);
    // The dienst of 31 augustus has been by the time of the moment: nothing to remind of.
    expect(stuurAutomatischeAiosRuilHerinneringen(new Date(2094, 8, 5, 12, 0, 0))).toBe(0);
    db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = NULL WHERE id = ?`).run(w.period);
    try {
      expect(stuurAutomatischeAiosRuilHerinneringen(plus(moment, 1))).toBe(0);
    } finally {
      db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = ? WHERE id = ?`).run(now, w.period);
    }
    expect(laatste(handmatig).op).toBeNull();
    trekAiosRuilIn(periode(), w.x, handmatig, plus(begin, 1));
  });
});

const dreq = (person: string, ruilId: string, body: unknown, als = person) =>
  new NextRequest(`http://localhost/api/aios/deelnemer/${person}/periode/${w.period}/ruilen/${ruilId}/herinneren`, {
    method: 'POST',
    headers: { cookie: personCookie(als), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const dctx = (person: string, ruilId: string) => ({ params: Promise.resolve({ id: person, periodId: w.period, ruilId }) });
const preq = (ruilId: string, body: unknown, cookie = staffCookie(w.planner), periodId = w.period) =>
  new NextRequest(`http://localhost/api/aios/periode/${periodId}/ruilen/${ruilId}/herinneren`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const pctx = (ruilId: string, periodId = w.period) => ({ params: Promise.resolve({ id: periodId, ruilId }) });

describe('by hand', () => {
  let id: string;

  it('the requester: nothing without the yes, which says there was no reminder yet; then it is sent', async () => {
    // A request made now, for diensten still ahead (the route uses the real clock).
    const r = verzoek(w.x, w.y, x(0), y(0), new Date());
    id = r;
    await waitForMails(sink, 2);
    sink.received.length = 0;
    const zonder = await herinnerDeelnemer(dreq(w.x, id, {}), dctx(w.x, id));
    expect(zonder.status).toBe(409);
    const fout = (await zonder.json()).error;
    expect(fout).toMatchObject({ code: 'BEVESTIGING', laatste_herinnering_op: null });
    expect(sink.received).toHaveLength(0);
    expect(laatste(id).op).toBeNull();

    const met = await herinnerDeelnemer(dreq(w.x, id, { bevestigd: true }), dctx(w.x, id));
    expect(met.status).toBe(200);
    expect(laatste(id).door).toBe('AANVRAGER');
    await waitForMails(sink, 2);
    const berichten = sink.received.map((m) => verzendlijstPayload(m.raw).berichten[0]);
    expect(berichten.find((b) => b.soort === 'RUIL_HERINNERING')!.codenaam).toBe(cn('y'));
    expect(berichten.find((b) => b.soort === 'RUIL_HERINNERING_BEVESTIGING')!.tekst).toContain('Je hebt zelf een herinnering gestuurd.');
    const audit = db.prepare(`SELECT COUNT(*) AS n FROM dienstrooster_audit_log WHERE entiteit = 'aios_ruil' AND entiteit_id = ? AND nieuw_json LIKE '%AANVRAGER%'`).get(id);
    expect(audit).toEqual({ n: 1 });
  });

  it('not within 24 hours of the last one, and the answer says when it went', async () => {
    const eerst = laatste(id).op!;
    for (const maak of [
      () => herinnerDeelnemer(dreq(w.x, id, { bevestigd: true }), dctx(w.x, id)),
      () => herinnerPlanner(preq(id, { bevestigd: true }), pctx(id)),
    ]) {
      const res = await maak();
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatchObject({ code: 'TOO_SOON', laatste_herinnering_op: eerst });
    }
    // 25 hours later by the same rule in the library: allowed again.
    db.prepare(`UPDATE dienstrooster_aios_ruil SET laatste_herinnering_op = ? WHERE id = ?`).run(plus(new Date(), -25).toISOString(), id);
    const weer = await herinnerPlanner(preq(id, { bevestigd: true }), pctx(id));
    expect(weer.status).toBe(200);
    expect(laatste(id).door).toBe('PLANNER');
    await waitForMails(sink, 2);
    const bevestiging = sink.received.map((m) => verzendlijstPayload(m.raw).berichten[0]).find((b) => b.soort === 'RUIL_HERINNERING_BEVESTIGING')!;
    expect(bevestiging.tekst).toContain('De planner heeft een herinnering gestuurd.');
  });

  it('only the requester for their own request, and only the AIOS planner for the AIOS', async () => {
    // The colleague cannot press the requester's button.
    expect((await herinnerDeelnemer(dreq(w.y, id, { bevestigd: true }), dctx(w.y, id))).status).toBe(404);
    // Someone else's page is not theirs.
    expect((await herinnerDeelnemer(dreq(w.x, id, { bevestigd: true }, w.y), dctx(w.x, id))).status).toBe(403);
    // The achterwacht's planner finds nothing of the AIOS's.
    expect((await herinnerPlanner(preq(id, { bevestigd: true }, staffCookie(staf.planner)), pctx(id))).status).toBe(404);
  });

  it('not for a request that was answered, taken back or is on a voorlopig roster', async () => {
    db.prepare(`UPDATE dienstrooster_aios_ruil SET laatste_herinnering_op = NULL WHERE id = ?`).run(id);
    db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = NULL WHERE id = ?`).run(w.period);
    try {
      const voorlopig = await herinnerDeelnemer(dreq(w.x, id, { bevestigd: true }), dctx(w.x, id));
      expect(voorlopig.status).toBe(409);
      expect((await voorlopig.json()).error.code).toBe('NOT_DEFINITIEF');
    } finally {
      db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = ? WHERE id = ?`).run(now, w.period);
    }
    expect(trekAiosRuilIn(periode(), w.x, id).ok).toBe(true);
    const klaar = await herinnerDeelnemer(dreq(w.x, id, { bevestigd: true }), dctx(w.x, id));
    expect(klaar.status).toBe(409);
    expect((await klaar.json()).error.code).toBe('HANDLED');
  });
});
