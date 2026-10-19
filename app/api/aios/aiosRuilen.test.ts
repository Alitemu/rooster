import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { bewaarAiosStroomAdres } from '@/lib/aiosMail';
import { aiosPersoonlijkeLink, aiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { aiosEenheden, aiosRuilKandidaten, doorgevenAan, losseSleutel } from '@/lib/aiosRuilen';
import { trekAiosPublicatieIn } from '@/lib/aiosPublicatie';
import { loadAiosPeriode, setAiosVoorkeur } from '@/lib/aiosPreferences';
import { saveAiosReden } from '@/lib/aiosReden';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, waitForMails, type SmtpSink } from '@/tests/smtpSink';
import { GET as overzicht, POST as aanvragen } from './deelnemer/[id]/periode/[periodId]/ruilen/route';
import { GET as kandidaten } from './deelnemer/[id]/periode/[periodId]/ruilen/kandidaten/route';
import { POST as goedkeuren } from './deelnemer/[id]/periode/[periodId]/ruilen/[ruilId]/goedkeuren/route';
import { POST as afwijzen } from './deelnemer/[id]/periode/[periodId]/ruilen/[ruilId]/afwijzen/route';
import { POST as intrekken } from './deelnemer/[id]/periode/[periodId]/ruilen/[ruilId]/intrekken/route';
import { GET as plannerRuilen } from './periode/[id]/ruilen/route';
import { POST as wijzigen } from './periode/[id]/rooster/wijzigen/route';
import { buildWorld, deleteRowsAfter, insert, now, personCookie, rowidSnapshot, staff, staffCookie, tag, type World } from '../../../tests/fixtures/dienstWorlds';

/**
 * Swapping between AIOS (lib/aiosRuilen.ts, step 4f):
 * - what counts as one eenheid and which are equal (the planner's words):
 *   a whole block for one of the same soort and vorm, a dagdienst and an
 *   evening at the weekend equal, a Saturday single, a block another has a
 *   day of no longer a block;
 * - only colleagues' equal eenheden that break no hard rule for either (L3),
 *   still to come;
 * - a request anonymous by mail; approved, the diensten change hands, the
 *   planner and the roosterbureau are told, other requests for them lapse;
 *   rejected with a reason; taken back; lapsed when the planner changed one
 *   by hand or the publication is withdrawn;
 * - only on a published roster, only the AIOS's own.
 */

const AAN_AIOS = 'stroom-aios@example.test';
const START = '2094-07-07';
const EIND = '2094-10-05';

let snapshot: Map<string, number>;
let staf: World;
let sink: SmtpSink;
const w = {} as { pool: string; period: string; planner: string; x: string; y: string; z: string; v: string };

const pctx = (person: string) => ({ params: Promise.resolve({ id: person, periodId: w.period }) });
const rctx = (person: string, ruilId: string) => ({ params: Promise.resolve({ id: person, periodId: w.period, ruilId }) });
const preq = (person: string, pad: string, method = 'GET', body?: unknown, als = person) =>
  new NextRequest(`http://localhost/api/aios/deelnemer/${person}/periode/${w.period}/ruilen${pad}`, {
    method,
    headers: { cookie: personCookie(als), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const slot = (code: string, datum: string) =>
  db
    .prepare(
      `SELECT sl.id, sl.shift_block_id AS blok FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND st.code = ? AND sl.datum = ?`
    )
    .get(w.period, code, datum) as { id: string; blok: string | null };
const blokVan = (code: string, datum: string) => slot(code, datum).blok!;
const blokDiensten = (blok: string) => (db.prepare('SELECT id FROM dienstrooster_shift_slot WHERE shift_block_id = ? ORDER BY datum').all(blok) as Array<{ id: string }>).map((r) => r.id);
const geef = (ids: string[], wie: string) =>
  ids.forEach((id) => insert('dienstrooster_assignment', { schedule_version_id: w.period, person_id: wie, slot_id: id, bron: 'SOLVER', row_version: 1, aangemaakt_op: now }));
const wieHeeft = (id: string) => (db.prepare('SELECT person_id FROM dienstrooster_assignment WHERE slot_id = ?').get(id) as { person_id: string } | undefined)?.person_id ?? null;
const status = (id: string) => (db.prepare('SELECT status FROM dienstrooster_aios_ruil WHERE id = ?').get(id) as { status: string }).status;
const cn = (n: string) => `aiosruil-${n}-${tag}`;

async function vraag(van: string, aangeboden: string, gevraagd: string, toelichting?: string) {
  const res = await aanvragen(preq(van, '', 'POST', { aangeboden, gevraagd, toelichting }), pctx(van));
  return { status: res.status, json: await res.json() };
}

beforeAll(async () => {
  snapshot = rowidSnapshot();
  sink = await startSmtpSink();
  configureSmtp(sink, { aan: 'stroom@example.test' });
  staf = buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  bewaarAiosStroomAdres(AAN_AIOS, w.planner);
  process.env.BASE_URL = 'http://localhost:3000';
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosRuil-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosRuil-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  w.period = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `AiosRuil-${tag}`,
    start_datum: START,
    eind_datum: EIND,
    deadline: '2094-05-01T17:00',
    status: 'GEPUBLICEERD',
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
  w.v = deelnemer('v');
  // Nachtblokken wo t/m vr: x in week 2 (14 to 16 juli), y in week 4 (28 to 30 juli), v in week 3 (21 to 23 juli).
  geef(blokDiensten(blokVan('ND', '2094-07-14')), w.x);
  geef(blokDiensten(blokVan('ND', '2094-07-28')), w.y);
  geef(blokDiensten(blokVan('ND', '2094-07-21')), w.v);
  // x the dagdienst of Saturday 24 juli (right after v's block: a swap for it would put x on its compensation day).
  geef([slot('DD', '2094-07-24').id], w.x);
  // y the Saturday evening of 31 juli, z the dagdienst of Sunday 8 augustus, z an uitloopdienst.
  geef(blokDiensten(blokVan('ADW', '2094-07-31')), w.y);
  geef([slot('DD', '2094-08-08').id], w.z);
  geef([slot('UD', '2094-08-02').id], w.z);
});

afterAll(async () => {
  delete process.env.BASE_URL;
  bewaarAiosStroomAdres('', w.planner);
  clearSmtpConfig();
  await sink.close();
  deleteRowsAfter(snapshot);
});

beforeEach(() => {
  sink.received.length = 0;
});

describe('what can be swapped for what', () => {
  it('a dagdienst and an evening at the weekend equal; a night, an evening in the week and an uitloopdienst each their own', () => {
    expect(losseSleutel('DD')).toBe(losseSleutel('ADW'));
    expect(new Set(['ND', 'AD', 'UD', 'DD'].map(losseSleutel)).size).toBe(4);
  });

  it('a whole block one eenheid, the Saturday single, a block another has a day of single diensten', () => {
    const slots = [
      { id: 'n1', datum: '2094-07-14', code: 'ND', blok_id: 'B', soort: 'NACHT', vorm: 'WO_VR', opgeknipt: null },
      { id: 'n2', datum: '2094-07-15', code: 'ND', blok_id: 'B', soort: 'NACHT', vorm: 'WO_VR', opgeknipt: null },
      { id: 'za', datum: '2094-07-17', code: 'ADW', blok_id: 'Z', soort: 'AVOND', vorm: 'ZA', opgeknipt: null },
      { id: 'k1', datum: '2094-07-18', code: 'ND', blok_id: 'K', soort: 'NACHT', vorm: 'ZO_DI', opgeknipt: 1 },
    ] as const;
    const heel = aiosEenheden([...slots], new Map([['n1', 'a'], ['n2', 'a'], ['za', 'b'], ['k1', 'c']]));
    expect(heel.map((e) => [e.id, e.sleutel])).toEqual([
      ['blok:B', 'BLOK_NACHT_WO_VR'],
      ['dienst:za', 'DAG_OF_WEEKENDAVOND'],
      ['dienst:k1', 'NACHT'],
    ]);
    const gesplitst = aiosEenheden([...slots], new Map([['n1', 'a'], ['n2', 'b']]));
    expect(gesplitst.map((e) => [e.id, e.sleutel])).toEqual([
      ['dienst:n1', 'NACHT'],
      ['dienst:n2', 'NACHT'],
    ]);
  });

  it('only equal ones of a colleague, still to come, that break no hard rule for either', async () => {
    const res = await kandidaten(preq(w.x, `/kandidaten?eenheid=blok:${blokVan('ND', '2094-07-14')}`), pctx(w.x));
    expect(res.status).toBe(200);
    const k = (await res.json()).data;
    // y's block in week 4; not v's in week 3: x would work on the Saturday after it, a compensation day.
    expect(k.map((c: any) => [c.collega.codenaam, c.eenheid.id])).toEqual([[cn('y'), `blok:${blokVan('ND', '2094-07-28')}`]]);
    const dag = (await (await kandidaten(preq(w.x, `/kandidaten?eenheid=dienst:${slot('DD', '2094-07-24').id}`), pctx(w.x))).json()).data;
    expect(dag.map((c: any) => c.eenheid.id).sort()).toEqual([`dienst:${slot('ADW', '2094-07-31').id}`, `dienst:${slot('DD', '2094-08-08').id}`].sort());
    // After the dienst has been: nothing.
    expect(aiosRuilKandidaten(aiosUitnodigPeriode(w.period)!, w.x, `dienst:${slot('DD', '2094-07-24').id}`, new Date('2094-07-25T12:00:00'))).toBeNull();
  });
});

describe('a request', () => {
  it('not for what is not equal, not theirs, or breaks a rule', async () => {
    const mijnBlok = `blok:${blokVan('ND', '2094-07-14')}`;
    expect((await vraag(w.x, mijnBlok, `dienst:${slot('DD', '2094-08-08').id}`)).json.error.code).toBe('NOT_EQUAL');
    expect((await vraag(w.x, `blok:${blokVan('ND', '2094-07-28')}`, mijnBlok)).status).toBe(400);
    const regel = await vraag(w.x, mijnBlok, `blok:${blokVan('ND', '2094-07-21')}`);
    expect(regel.status).toBe(409);
    expect(regel.json.error.message).toMatch(/^Deze ruil kan niet: Een dienst op een compensatiedag/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_aios_ruil WHERE period_id = ?').get(w.period)).toEqual({ n: 0 });
  });

  it('asked: anonymous by mail to the colleague, a confirmation to the requester', async () => {
    const r = await vraag(w.x, `blok:${blokVan('ND', '2094-07-14')}`, `blok:${blokVan('ND', '2094-07-28')}`, 'ik heb een cursus');
    expect(r.status).toBe(200);
    expect(r.json.data.mail).toBe(true);
    expect(status(r.json.data.id)).toBe('IN_BEHANDELING');
    await waitForMails(sink, 2);
    const lijsten = sink.received.map((m) => verzendlijstPayload(m.raw));
    const verzoek = lijsten.find((l) => l.soort === 'RUILVERZOEK')!.berichten[0];
    expect(verzoek.codenaam).toBe(cn('y'));
    expect(verzoek.personen).toEqual([cn('y')]);
    expect(verzoek.tekst).not.toContain(cn('x'));
    expect(verzoek.tekst).toContain('Jij geeft: nachtblok wo t/m vr van woensdag 28 juli 2094 tot en met vrijdag 30 juli 2094');
    expect(verzoek.tekst).toContain('Toelichting: ik heb een cursus');
    expect(lijsten.find((l) => l.soort === 'RUIL_BEVESTIGING')!.berichten[0].codenaam).toBe(cn('x'));
    expect((await vraag(w.x, `blok:${blokVan('ND', '2094-07-14')}`, `blok:${blokVan('ND', '2094-07-28')}`)).json.error.code).toBe('DUPLICATE');
  });

  it('on both pages', async () => {
    const x = (await (await overzicht(preq(w.x, ''), pctx(w.x))).json()).data;
    const y = (await (await overzicht(preq(w.y, ''), pctx(w.y))).json()).data;
    expect(x.uit).toHaveLength(1);
    expect(y.in).toHaveLength(1);
    expect(y.in[0]).toMatchObject({ aanvrager: cn('x'), status: 'IN_BEHANDELING', toelichting: 'ik heb een cursus' });
    // Another's page is not theirs.
    expect((await overzicht(preq(w.y, '', 'GET', undefined, w.x), pctx(w.y))).status).toBe(403);
  });
});

describe('the answer', () => {
  it('approved on a voorlopig roster: the diensten change hands, only the planner is told, the roosterbureau is not', async () => {
    const y = (await (await overzicht(preq(w.y, ''), pctx(w.y))).json()).data;
    const id = y.in[0].id;
    // Only the colleague asked can approve it.
    expect((await goedkeuren(preq(w.x, `/${id}/goedkeuren`, 'POST', {}), rctx(w.x, id))).status).toBe(404);
    const res = await goedkeuren(preq(w.y, `/${id}/goedkeuren`, 'POST', {}), rctx(w.y, id));
    expect(res.status).toBe(200);
    expect(status(id)).toBe('GOEDGEKEURD');
    expect(blokDiensten(blokVan('ND', '2094-07-14')).map(wieHeeft)).toEqual([w.y, w.y, w.y]);
    expect(blokDiensten(blokVan('ND', '2094-07-28')).map(wieHeeft)).toEqual([w.x, w.x, w.x]);
    const edits = db
      .prepare(`SELECT person_id, oorspronkelijke_person_id FROM dienstrooster_assignment_edit WHERE periode_id = ? AND edit_type = 'RUIL'`)
      .all(w.period);
    expect(edits).toHaveLength(6);
    await waitForMails(sink, 2);
    const lijsten = sink.received.map((m) => verzendlijstPayload(m.raw));
    const uitkomst = lijsten.find((l) => l.soort === 'RUIL_UITKOMST')!.berichten[0];
    expect(uitkomst.tekst).toContain(`${cn('y')} heeft je ruil goedgekeurd`);
    const door = lijsten.find((l) => l.soort === 'RUIL_DOORGEVEN')!.berichten;
    expect(door.map((b) => b.codenaam)).toEqual(['Planner']);
    expect(door[0].personen.sort()).toEqual([cn('x'), cn('y')].sort());
    expect((await goedkeuren(preq(w.y, `/${id}/goedkeuren`, 'POST', {}), rctx(w.y, id))).status).toBe(409);
  });

  it('rejected with a reason; the mail says no more than that', async () => {
    const r = await vraag(w.x, `dienst:${slot('DD', '2094-07-24').id}`, `dienst:${slot('DD', '2094-08-08').id}`);
    expect(r.status).toBe(200);
    await waitForMails(sink, 2);
    sink.received.length = 0;
    const res = await afwijzen(preq(w.z, `/${r.json.data.id}/afwijzen`, 'POST', { reden: 'dan ben ik weg' }), rctx(w.z, r.json.data.id));
    expect(res.status).toBe(200);
    expect(status(r.json.data.id)).toBe('AFGEWEZEN');
    await waitForMails(sink, 1);
    const b = verzendlijstPayload(sink.received[0].raw).berichten[0];
    expect(b).toMatchObject({ soort: 'RUIL_UITKOMST', codenaam: cn('x'), personen: [cn('x')] });
    expect(b.tekst).toContain('Reden: dan ben ik weg');
    expect(b.tekst).not.toContain(cn('z'));
  });

  it('taken back by who asked, not by the colleague', async () => {
    // x now has y's old night block (28 to 30 juli): the Saturday evening after it is out of reach, the dagdienst of 8 augustus not.
    const r = await vraag(w.x, `dienst:${slot('DD', '2094-07-24').id}`, `dienst:${slot('DD', '2094-08-08').id}`);
    expect(r.status).toBe(200);
    const id = r.json.data.id;
    await waitForMails(sink, 2);
    expect((await intrekken(preq(w.z, `/${id}/intrekken`, 'POST', {}), rctx(w.z, id))).status).toBe(404);
    sink.received.length = 0;
    expect((await intrekken(preq(w.x, `/${id}/intrekken`, 'POST', {}), rctx(w.x, id))).status).toBe(200);
    expect(status(id)).toBe('INGETROKKEN');
    await waitForMails(sink, 1);
    expect(verzendlijstPayload(sink.received[0].raw).berichten[0]).toMatchObject({ soort: 'RUIL_INGETROKKEN', codenaam: cn('z') });
  });
});

describe('lapsed', () => {
  it('when the planner gives one of its diensten to someone else by hand', async () => {
    const dd = slot('DD', '2094-07-24').id;
    const r = await vraag(w.x, `dienst:${dd}`, `dienst:${slot('DD', '2094-08-08').id}`);
    expect(r.status).toBe(200);
    const res = await wijzigen(
      new NextRequest(`http://localhost/api/aios/periode/${w.period}/rooster/wijzigen`, {
        method: 'POST',
        headers: { cookie: staffCookie(w.planner), 'content-type': 'application/json' },
        body: JSON.stringify({ wijzigingen: [{ dienst_id: dd, aios_id: w.v, was: w.x }], reden: 'x is ziek' }),
      }),
      { params: Promise.resolve({ id: w.period }) }
    );
    expect(res.status).toBe(200);
    expect(status(r.json.data.id)).toBe('VERVALLEN');
    const ja = await goedkeuren(preq(w.z, `/${r.json.data.id}/goedkeuren`, 'POST', {}), rctx(w.z, r.json.data.id));
    expect(ja.status).toBe(409);
  });

  it('when the publication is withdrawn; and no swapping then', async () => {
    // v has the dagdienst of 24 juli now (the planner's change above).
    const r = await vraag(w.z, `dienst:${slot('DD', '2094-08-08').id}`, `dienst:${slot('DD', '2094-07-24').id}`);
    expect(r.status).toBe(200);
    expect(trekAiosPublicatieIn(aiosUitnodigPeriode(w.period)!, w.planner).ok).toBe(true);
    expect(status(r.json.data.id)).toBe('VERVALLEN');
    expect((await overzicht(preq(w.z, ''), pctx(w.z))).status).toBe(404);
    expect((await vraag(w.z, `dienst:${slot('DD', '2094-08-08').id}`, `dienst:${slot('DD', '2094-07-24').id}`)).json.error.code).toBe('NOT_PUBLISHED');
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEPUBLICEERD' WHERE id = ?`).run(w.period);
  });
});

describe('the planner', () => {
  it('sees every request; the achterwacht planner nothing', async () => {
    const res = await plannerRuilen(new NextRequest(`http://localhost/api/aios/periode/${w.period}/ruilen`, { headers: { cookie: staffCookie(w.planner) } }), {
      params: Promise.resolve({ id: w.period }),
    });
    const lijst = (await res.json()).data;
    expect(lijst.map((r: any) => r.status).sort()).toEqual(['AFGEWEZEN', 'GOEDGEKEURD', 'INGETROKKEN', 'VERVALLEN', 'VERVALLEN']);
    const stafRes = await plannerRuilen(new NextRequest(`http://localhost/api/aios/periode/${w.period}/ruilen`, { headers: { cookie: staffCookie(staf.planner) } }), {
      params: Promise.resolve({ id: w.period }),
    });
    expect(stafRes.status).toBe(404);
  });
});

describe('a parttimer', () => {
  it("is offered for an evening on their part-time day, never for its uitloopdienst", () => {
    // Since 0.82.0 a part-time day's evening is liever niet, not a hard rule
    // (the planner's choice): a swap may put the parttimer there.
    const p = insert('dienstrooster_person', { codenaam: cn('p'), rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    const q = insert('dienstrooster_person', { codenaam: cn('q'), rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    for (const id of [p, q]) {
      insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    }
    insert('dienstrooster_parttime_pattern', { person_id: p, weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31', aangemaakt_door: p, aangemaakt_op: now });
    // Evening blocks zo t/m di: q's over Monday 30 augustus, p's over Monday 13 september.
    geef(blokDiensten(blokVan('ADW', '2094-08-29')), q);
    geef(blokDiensten(blokVan('ADW', '2094-09-12')), p);
    // Uitloopdiensten: q's on Monday 20 september, p's on Tuesday 21 september.
    geef([slot('UD', '2094-09-20').id], q);
    geef([slot('UD', '2094-09-21').id], p);
    const periode = aiosUitnodigPeriode(w.period)!;
    const nu = new Date('2094-08-01T12:00:00');
    const voor = (eenheid: string) => aiosRuilKandidaten(periode, q, eenheid, nu)!.map((k) => k.eenheid.id);
    expect(voor(`blok:${blokVan('ADW', '2094-08-29')}`)).toContain(`blok:${blokVan('ADW', '2094-09-12')}`);
    expect(voor(`dienst:${slot('UD', '2094-09-20').id}`)).not.toContain(`dienst:${slot('UD', '2094-09-21').id}`);
  });
});

describe("the AIOS's toelichting bij een dag (lib/aiosReden.ts)", () => {
  it('is never in a swap request, its mail, the candidates, the pages of the colleagues or the planner', async () => {
    const GEHEIM = `geheime-reden-${tag}`;
    const dagdienst = slot('DD', '2094-08-08').id;
    expect(setAiosVoorkeur(w.z, w.period, dagdienst, 'LIEVER_NIET')).toEqual({ ok: true });
    expect(saveAiosReden(w.z, loadAiosPeriode(w.period)!, '2094-08-08', GEHEIM)).toEqual({ ok: true });
    sink.received.length = 0;
    // v asks z for the dagdienst of 8 augustus, the one z gave a toelichting for.
    const r = await vraag(w.v, `dienst:${slot('DD', '2094-07-24').id}`, `dienst:${dagdienst}`);
    expect(r.status).toBe(200);
    await waitForMails(sink, 2);
    const gezien = [JSON.stringify(r.json), ...sink.received.map((m) => JSON.stringify(verzendlijstPayload(m.raw)))];
    for (const wie of [w.v, w.z, w.x]) gezien.push(JSON.stringify(await (await overzicht(preq(wie, ''), pctx(wie))).json()));
    const kandidatenVoorV = JSON.stringify(
      await (await kandidaten(preq(w.v, `/kandidaten?eenheid=dienst:${slot('DD', '2094-07-24').id}`), pctx(w.v))).json()
    );
    // Not vacuous: z is among them.
    expect(kandidatenVoorV).toContain(dagdienst);
    gezien.push(kandidatenVoorV);
    gezien.push(
      JSON.stringify(
        await (
          await plannerRuilen(new NextRequest(`http://localhost/api/aios/periode/${w.period}/ruilen`, { headers: { cookie: staffCookie(w.planner) } }), {
            params: Promise.resolve({ id: w.period }),
          })
        ).json()
      )
    );
    for (const tekst of gezien) expect(tekst).not.toContain(GEHEIM);
  });
});

describe('who is told when a swap went through', () => {
  it('the roosterbureau only once the roster is definitief; before, the planner alone', () => {
    expect(doorgevenAan(w.period)).toEqual(['Planner']);
    db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = ? WHERE id = ?`).run(now, w.period);
    try {
      expect(doorgevenAan(w.period)).toEqual(['Planner', 'Roosterbureau']);
      // Not definitief when it is not even published.
      db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD' WHERE id = ?`).run(w.period);
      expect(doorgevenAan(w.period)).toEqual(['Planner']);
    } finally {
      db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = NULL, status = 'GEPUBLICEERD' WHERE id = ?`).run(w.period);
    }
  });
});
