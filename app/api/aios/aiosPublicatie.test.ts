import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { bewaarAiosStroomAdres } from '@/lib/aiosMail';
import { aiosPersoonlijkeLink } from '@/lib/aiosUitnodigen';
import { readFirstSheet } from '@/lib/xlsx';
import { excelSerialToDate } from '@/lib/isoDate';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, type SmtpSink } from '@/tests/smtpSink';
import { GET as publicatie } from './periode/[id]/publicatie/route';
import { POST as publiceren } from './periode/[id]/publiceren/route';
import { POST as definitief } from './periode/[id]/definitief-maken/route';
import { POST as intrekken } from './periode/[id]/publicatie-intrekken/route';
import { POST as roosterMail } from './periode/[id]/rooster-mail/route';
import { claimAiosVerzending } from '@/lib/aiosInFlight';
import { GET as downloadRooster } from './periode/[id]/download-rooster/route';
import { GET as downloadPerAios } from './periode/[id]/download-per-aios/route';
import { POST as wijzigen } from './periode/[id]/rooster/wijzigen/route';
import { POST as genereren } from './periode/[id]/genereren/route';
import { GET as mijnRooster } from './deelnemer/[id]/periode/[periodId]/rooster/route';
import { buildWorld, deleteRowsAfter, insert, now, personCookie, rowidSnapshot, staff, staffCookie, tag, type World } from '../../../tests/fixtures/dienstWorlds';

/**
 * Publishing the AIOS's roster (lib/aiosPublicatie.ts, step 4d):
 * - an empty dienst stops it (D2); a hard rule broken or a dienstpercentage
 *   above 25% needs the planner's yes;
 * - voorlopig: gepubliceerd, what was published kept, every AIOS mailed
 *   their own diensten through the AIOS's own flow; the AIOS sees them, and
 *   their dienstpercentage, on their page, not before;
 * - on a published roster a change by hand needs a reason, and no new roster;
 * - definitief: by hand, the check again, the mail with what changed;
 * - intrekken: back to gegenereerd, every dienst kept, the AIOS sees nothing;
 * - the roster as Excel: per dag, and per AIOS with the compensation days;
 * - the AIOS's planner's only.
 */

const AAN_AIOS = 'stroom-aios@example.test';
const START = '2094-07-07'; // a Wednesday: 13 weeks, 65 werkdagen, no feestdagen
const EIND = '2094-10-05';

let snapshot: Map<string, number>;
let staf: World;
let sink: SmtpSink;
const w = {} as { pool: string; period: string; planner: string; x: string; y: string };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (pad: string, method = 'GET', body?: unknown, cookie = staffCookie(w.planner)) =>
  new NextRequest(`http://localhost/api/aios/periode/${pad}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const doe = async (route: typeof publiceren, pad: string, body: unknown = {}) => {
  const res = await route(req(`${w.period}/${pad}`, 'POST', body), ctx(w.period));
  return { status: res.status, json: await res.json() };
};
const stand = () =>
  db.prepare('SELECT status, gepubliceerd_op, definitief_op, voorlopig_rooster_json FROM dienstrooster_schedule_period WHERE id = ?').get(w.period) as {
    status: string;
    gepubliceerd_op: string | null;
    definitief_op: string | null;
    voorlopig_rooster_json: string | null;
  };
const slots = () =>
  db
    .prepare(
      `SELECT sl.id, sl.datum, st.code FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id WHERE sl.period_id = ? ORDER BY sl.datum, st.start_tijd`
    )
    .all(w.period) as Array<{ id: string; datum: string; code: string }>;
const slot = (code: string, datum: string) => slots().find((s) => s.code === code && s.datum === datum)!;
const wieHeeft = (id: string) =>
  (db.prepare('SELECT person_id FROM dienstrooster_assignment WHERE slot_id = ?').get(id) as { person_id: string } | undefined)?.person_id ?? null;
const mijn = async (personId: string) => {
  const res = await mijnRooster(
    new NextRequest(`http://localhost/api/aios/deelnemer/${personId}/periode/${w.period}/rooster`, { headers: { cookie: personCookie(personId) } }),
    { params: Promise.resolve({ id: personId, periodId: w.period }) }
  );
  return { status: res.status, json: await res.json() };
};
const blad = async (route: typeof downloadRooster) => {
  const res = await route(req(`${w.period}/download`), ctx(w.period));
  expect(res.status).toBe(200);
  return readFirstSheet(Buffer.from(await res.arrayBuffer()));
};

beforeAll(async () => {
  snapshot = rowidSnapshot();
  sink = await startSmtpSink();
  configureSmtp(sink, { aan: 'stroom@example.test' });
  staf = buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  bewaarAiosStroomAdres(AAN_AIOS, w.planner);
  process.env.BASE_URL = 'http://localhost:3000';
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosPub-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosPub-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  w.period = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `AiosPub-${tag}`,
    start_datum: START,
    eind_datum: EIND,
    deadline: '2094-05-01T17:00',
    status: 'GEGENEREERD',
    auto_herinneren: 0,
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(w.period, aiosShiftTypes(w.pool)!, START, EIND))();
  const deelnemer = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: `aiospub-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
  // Their links from the invitation: a participant's session needs one.
  for (const id of [w.x, w.y]) aiosPersoonlijkeLink(id, w.period, 'http://localhost:3000');
  // The roster: x the first night block wo t/m vr (7 to 9 juli), everything else y but one uitloopdienst.
  const xNacht = new Set(['2094-07-07', '2094-07-08', '2094-07-09']);
  for (const s of slots()) {
    if (s.code === 'UD' && s.datum === '2094-07-12') continue;
    const wie = s.code === 'ND' && xNacht.has(s.datum) ? w.x : w.y;
    insert('dienstrooster_assignment', { schedule_version_id: w.period, person_id: wie, slot_id: s.id, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  }
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

describe('before publishing', () => {
  it('an empty dienst stops it', async () => {
    const r = await doe(publiceren, 'publiceren', { bevestigd: true });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'NOT_READY', message: '1 dienst is nog leeg. Vul die eerst met de hand.' });
    expect(stand().status).toBe('GEGENEREERD');
    expect(sink.received).toHaveLength(0);
  });

  it('warnings need a yes: y is far above 25%, and works on their compensation days', async () => {
    const ud = slot('UD', '2094-07-12');
    insert('dienstrooster_assignment', { schedule_version_id: w.period, person_id: w.x, slot_id: ud.id, bron: 'MANUAL', row_version: 1, aangemaakt_op: now });
    const check = (await (await publicatie(req(`${w.period}/publicatie`), ctx(w.period))).json()).data;
    expect(check).toMatchObject({ status: 'GEGENEREERD', gepubliceerd_op: null, mail_ingesteld: true });
    expect(check.controle.problemen).toEqual([]);
    expect(check.controle.waarschuwingen).toEqual(expect.arrayContaining([expect.stringMatching(/^aiospub-y-.*: dienstpercentage .*, boven 25%\.$/)]));
    expect(check.controle.waarschuwingen.some((t: string) => t.includes('Een dienst op een compensatiedag'))).toBe(true);
    const r = await doe(publiceren, 'publiceren', {});
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('WARNINGS');
    expect(r.json.error.controle.waarschuwingen.length).toBe(check.controle.waarschuwingen.length);
    expect(stand().status).toBe('GEGENEREERD');
  });

  it('the AIOS sees nothing yet', async () => {
    expect((await mijn(w.x)).status).toBe(404);
  });

  it('not while a roster is being made', async () => {
    const opslag = globalThis as unknown as { __aiosGeneratieJobs?: Map<string, unknown> };
    opslag.__aiosGeneratieJobs ??= new Map();
    opslag.__aiosGeneratieJobs.set('loopt', { id: 'loopt', periodId: w.period, status: 'BEZIG', gestart: Date.now() });
    try {
      const r = await doe(publiceren, 'publiceren', { bevestigd: true });
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('GENERATION_RUNNING');
    } finally {
      opslag.__aiosGeneratieJobs.delete('loopt');
    }
  });

  it('no workbook before there is a roster', async () => {
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GESLOTEN' WHERE id = ?`).run(w.period);
    try {
      for (const [route, pad] of [
        [downloadRooster, 'download-rooster'],
        [downloadPerAios, 'download-per-aios'],
      ] as const) {
        const res = await route(req(`${w.period}/${pad}`), ctx(w.period));
        expect(res.status).toBe(409);
        // Not "nog niet definitief": there is no roster to be definitief.
        expect((await res.json()).error.code).toBe('INVALID_STATUS');
      }
      const r = await doe(publiceren, 'publiceren', { bevestigd: true });
      expect(r.status).toBe(409);
      expect(r.json.error.message).toMatch(/^Publiceren kan als het rooster gemaakt is/);
    } finally {
      db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD' WHERE id = ?`).run(w.period);
    }
  });
});

describe('voorlopig', () => {
  it('publishes, keeps what was published and mails every AIOS their own diensten', async () => {
    const r = await doe(publiceren, 'publiceren', { bevestigd: true });
    expect(r.status).toBe(200);
    expect(r.json.data.mail).toEqual({ verstuurd: true, aantal: 2 });
    const s = stand();
    expect(s.status).toBe('GEPUBLICEERD');
    expect(s.gepubliceerd_op).not.toBeNull();
    expect(s.definitief_op).toBeNull();
    expect(JSON.parse(s.voorlopig_rooster_json!).filter((d: any) => d.person_id === w.x)).toHaveLength(4);

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].to).toEqual([AAN_AIOS]);
    const lijst = verzendlijstPayload(sink.received[0].raw);
    expect(lijst.soort).toBe('ROOSTER_VOORLOPIG');
    const x = lijst.berichten.find((b) => b.codenaam === `aiospub-x-${tag}`)!;
    expect(x.onderwerp).toBe(`Voorlopig rooster AIOS AiosPub-${tag}`);
    expect(x.tekst).toContain('Je hebt 4 diensten:');
    expect(x.tekst).toContain('- woensdag 7 juli 2094: nachtdienst');
    expect(x.tekst).toContain('- maandag 12 juli 2094: uitloopdienst');
    // 3,2 points in 65 werkdagen, fulltime.
    expect(x.tekst).toMatch(/Je dienstpercentage dit kwartaal: 4,9%\./);
    expect(x.tekst).toMatch(/http:\/\/localhost:3000\/aios\/[A-Za-z0-9_-]+/);
  });

  it('the AIOS sees their own diensten, voorlopig, and their dienstpercentage', async () => {
    const r = await mijn(w.x);
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ voorlopig: true, punten: 3.2 });
    expect(r.json.data.dienstpercentage).toBeCloseTo(3.2 / (65 * 1));
    expect(r.json.data.diensten.map((d: any) => [d.datum, d.code, d.blok])).toEqual([
      ['2094-07-07', 'ND', 'nachtblok wo t/m vr'],
      ['2094-07-08', 'ND', 'nachtblok wo t/m vr'],
      ['2094-07-09', 'ND', 'nachtblok wo t/m vr'],
      ['2094-07-12', 'UD', null],
    ]);
    // Only their own: another's page is not theirs.
    const ander = await mijnRooster(
      new NextRequest(`http://localhost/api/aios/deelnemer/${w.y}/periode/${w.period}/rooster`, { headers: { cookie: personCookie(w.x) } }),
      { params: Promise.resolve({ id: w.y, periodId: w.period }) }
    );
    expect(ander.status).toBe(403);
  });

  it('the Excel for the roosterbureau is refused: a voorlopig roster goes nowhere outside the planner\'s page', async () => {
    for (const [route, pad] of [
      [downloadRooster, 'download-rooster'],
      [downloadPerAios, 'download-per-aios'],
    ] as const) {
      const res = await route(req(`${w.period}/${pad}`), ctx(w.period));
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('NOT_DEFINITIEF');
    }
  });

  it('a change by hand needs a reason now, and no new roster', async () => {
    const ud = slot('UD', '2094-07-12');
    const zonder = await wijzigen(req(`${w.period}/rooster/wijzigen`, 'POST', { wijzigingen: [{ dienst_id: ud.id, aios_id: w.y, was: w.x }] }), ctx(w.period));
    expect(zonder.status).toBe(400);
    expect((await zonder.json()).error.message).toMatch(/reden is verplicht/);
    expect(wieHeeft(ud.id)).toBe(w.x);
    const met = await wijzigen(
      req(`${w.period}/rooster/wijzigen`, 'POST', { wijzigingen: [{ dienst_id: ud.id, aios_id: w.y, was: w.x }], reden: 'x heeft onderwijs' }),
      ctx(w.period)
    );
    expect(met.status).toBe(200);
    expect(wieHeeft(ud.id)).toBe(w.y);
    const edit = db.prepare(`SELECT reden FROM dienstrooster_assignment_edit WHERE slot_id = ? AND edit_type = 'HANDMATIG_TOEWIJZEN'`).get(ud.id);
    expect(edit).toEqual({ reden: 'x heeft onderwijs' });
    expect((await genereren(req(`${w.period}/genereren`, 'POST', {}), ctx(w.period))).status).toBe(409);
  });
});

describe('definitief', () => {
  it('only once voorlopig, the check again, and the mail says what changed', async () => {
    const zonder = await doe(definitief, 'definitief-maken', {});
    expect(zonder.status).toBe(409);
    expect(zonder.json.error.code).toBe('WARNINGS');
    const r = await doe(definitief, 'definitief-maken', { bevestigd: true });
    expect(r.status).toBe(200);
    expect(r.json.data.mail).toEqual({ verstuurd: true, aantal: 2 });
    expect(stand().definitief_op).not.toBeNull();
    const lijst = verzendlijstPayload(sink.received[0].raw);
    expect(lijst.soort).toBe('ROOSTER_DEFINITIEF');
    const x = lijst.berichten.find((b) => b.codenaam === `aiospub-x-${tag}`)!;
    expect(x.tekst).toContain('Je hebt 3 diensten:');
    expect(x.tekst).toContain('Vervallen:\n- maandag 12 juli 2094: uitloopdienst');
    const y = lijst.berichten.find((b) => b.codenaam === `aiospub-y-${tag}`)!;
    expect(y.tekst).toContain('Erbij gekomen:\n- maandag 12 juli 2094: uitloopdienst');
    expect((await mijn(w.x)).json.data.voorlopig).toBe(false);
    const nogEens = await doe(definitief, 'definitief-maken', { bevestigd: true });
    expect(nogEens.status).toBe(409);
    expect(nogEens.json.error.message).toBe('Het rooster is al definitief.');
    const opnieuw = await doe(publiceren, 'publiceren', { bevestigd: true });
    expect(opnieuw.status).toBe(409);
    expect(opnieuw.json.error.message).toMatch(/^Publiceren kan als het rooster gemaakt is/);
  });
});

describe('rooster opnieuw mailen', () => {
  it('sends the definitieve mail again to every AIOS, leaving the roster as it is, and writes an audit row', async () => {
    const voor = stand();
    const r = await doe(roosterMail, 'rooster-mail');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.mail).toEqual({ verstuurd: true, aantal: 2 });
    expect(verzendlijstPayload(sink.received[0].raw).soort).toBe('ROOSTER_DEFINITIEF');
    expect(stand()).toEqual(voor);
    const rij = db
      .prepare(`SELECT nieuw_json FROM dienstrooster_audit_log WHERE entiteit_id = ? AND nieuw_json LIKE '%roostermail AIOS opnieuw verstuurd%'`)
      .get(w.period) as { nieuw_json: string };
    expect(JSON.parse(rij.nieuw_json)).toMatchObject({ soort: 'definitief', verstuurd: true, aantal: 2 });
  });

  it('is told to wait while the same send runs (409 BEZIG)', async () => {
    const release = claimAiosVerzending(`rooster-mail:${w.period}`)!;
    try {
      const r = await doe(roosterMail, 'rooster-mail');
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('BEZIG');
      expect(sink.received).toHaveLength(0);
    } finally {
      release();
    }
  });

  it('only for a published roster', async () => {
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD' WHERE id = ?`).run(w.period);
    try {
      expect((await doe(roosterMail, 'rooster-mail')).status).toBe(409);
      expect(sink.received).toHaveLength(0);
    } finally {
      db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEPUBLICEERD' WHERE id = ?`).run(w.period);
    }
  });
});

describe('the roster as Excel', () => {
  it('per dag: who has each dienst', async () => {
    const [kop, ...rijen] = await blad(downloadRooster);
    expect(kop).toEqual(['Datum', 'Dag', 'Week', 'Feestdag', 'Uitloopdienst', 'Dagdienst', 'Avonddienst', 'Nachtdienst']);
    expect(rijen).toHaveLength(91);
    const eerste = rijen[0];
    expect(excelSerialToDate(Number(eerste[0]))).toBe(START);
    expect(eerste.slice(1, 3)).toEqual(['woensdag', '27']);
    expect(eerste[7]).toBe(`aiospub-x-${tag}`);
    expect(eerste[6]).toBe(`aiospub-y-${tag}`);
  });

  it('per AIOS: the points and the compensation days', async () => {
    const [kop, ...rijen] = await blad(downloadPerAios);
    expect(kop[0]).toBe('AIOS');
    expect(kop[kop.length - 1]).toBe('Compensatiedagen');
    const x = rijen.find((r) => r[0] === `aiospub-x-${tag}`)!;
    // The night block wo t/m vr: Saturday and Sunday off.
    expect(x[x.length - 1]).toBe('za 10 jul, zo 11 jul');
  });
});

describe('intrekken', () => {
  it('back to gegenereerd, every dienst kept, the AIOS sees nothing', async () => {
    const voor = slots().map((s) => wieHeeft(s.id));
    const r = await doe(intrekken, 'publicatie-intrekken');
    expect(r.status).toBe(200);
    expect(stand()).toEqual({ status: 'GEGENEREERD', gepubliceerd_op: null, definitief_op: null, voorlopig_rooster_json: null });
    expect(slots().map((s) => wieHeeft(s.id))).toEqual(voor);
    expect((await mijn(w.x)).status).toBe(404);
    expect(sink.received).toHaveLength(0);
    expect((await doe(intrekken, 'publicatie-intrekken')).status).toBe(409);
  });

  it('publishing again starts voorlopig', async () => {
    expect((await doe(publiceren, 'publiceren', { bevestigd: true })).status).toBe(200);
    expect(stand().definitief_op).toBeNull();
    expect((await mijn(w.x)).json.data.voorlopig).toBe(true);
  });
});

describe('access', () => {
  it("is the AIOS's planner's: the achterwacht's planner gets nothing, nor an achterwacht period", async () => {
    const stafCookie = staffCookie(staf.planner);
    for (const [route, pad] of [
      [publiceren, 'publiceren'],
      [definitief, 'definitief-maken'],
      [intrekken, 'publicatie-intrekken'],
      [roosterMail, 'rooster-mail'],
    ] as const) {
      expect((await route(req(`${w.period}/${pad}`, 'POST', { bevestigd: true }, stafCookie), ctx(w.period))).status).toBe(404);
      expect((await route(req(`${staf.period}/${pad}`, 'POST', { bevestigd: true }), ctx(staf.period))).status).toBe(404);
    }
    expect((await downloadRooster(req(`${w.period}/download-rooster`, 'GET', undefined, stafCookie), ctx(w.period))).status).toBe(404);
    expect(stand().status).toBe('GEPUBLICEERD');
  });
});
