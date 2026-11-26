import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { bewaarAiosStroomAdres } from '@/lib/aiosMail';
import { aiosPersoonlijkeLink, aiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { laadAiosRooster } from '@/lib/aiosRooster';
import { readFirstSheet } from '@/lib/xlsx';
import { excelSerialToDate } from '@/lib/isoDate';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, type SmtpSink } from '@/tests/smtpSink';
import { POST as publiceren } from './periode/[id]/publiceren/route';
import { POST as definitief } from './periode/[id]/definitief-maken/route';
import { GET as downloadRooster } from './periode/[id]/download-rooster/route';
import { POST as wijzigen } from './periode/[id]/rooster/wijzigen/route';
import { GET as mijnRooster } from './deelnemer/[id]/periode/[periodId]/rooster/route';
import { buildWorld, deleteRowsAfter, insert, now, personCookie, rowidSnapshot, staff, staffCookie, tag } from '../../../tests/fixtures/dienstWorlds';

/**
 * A roster changed by hand is the current roster, on every way it leaves the app:
 * - the voorlopig mail to each AIOS, and the definitief mail;
 * - the AIOS's own page;
 * - the two Excel downloads for the roosterbureau.
 * Each is compared with the assignments in the database after the changes, so
 * one that still shows what the solver made fails, whatever the change was.
 */

const AAN_AIOS = 'stroom-handmatig@example.test';
const START = '2094-07-07'; // a Wednesday: 13 weeks, no feestdagen
const EIND = '2094-10-05';

let snapshot: Map<string, number>;
let sink: SmtpSink;
const w = {} as { pool: string; period: string; planner: string; x: string; y: string; z: string };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (pad: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://localhost/api/aios/periode/${pad}`, {
    method,
    headers: { cookie: staffCookie(w.planner), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const doe = async (route: typeof publiceren, pad: string) => {
  const res = await route(req(`${w.period}/${pad}`, 'POST', { bevestigd: true }), ctx(w.period));
  return { status: res.status, json: await res.json() };
};
const slots = () =>
  db
    .prepare(
      `SELECT sl.id, sl.datum, st.code FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id WHERE sl.period_id = ? ORDER BY sl.datum, st.start_tijd`
    )
    .all(w.period) as Array<{ id: string; datum: string; code: string }>;
const slot = (code: string, datum: string) => slots().find((s) => s.code === code && s.datum === datum)!;
const geef = async (code: string, datum: string, aan: string, was: string, reden?: string) => {
  const res = await wijzigen(
    req(`${w.period}/rooster/wijzigen`, 'POST', { wijzigingen: [{ dienst_id: slot(code, datum).id, aios_id: aan, was }], ...(reden ? { reden } : {}) }),
    ctx(w.period)
  );
  expect(res.status).toBe(200);
};

/** The truth: who holds what according to the database, as [datum, code, codenaam]. */
function werkelijk(): Array<[string, string, string]> {
  return (
    db
      .prepare(
        `SELECT sl.datum, st.code, p.codenaam FROM dienstrooster_assignment a
         JOIN dienstrooster_shift_slot sl ON sl.id = a.slot_id
         JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
         JOIN dienstrooster_person p ON p.id = a.person_id
         WHERE a.schedule_version_id = ? ORDER BY sl.datum, st.start_tijd`
      )
      .all(w.period) as Array<{ datum: string; code: string; codenaam: string }>
  ).map((r) => [r.datum, r.code, r.codenaam]);
}
const eigen = (codenaam: string) => werkelijk().filter((r) => r[2] === codenaam);
const naam = (n: string) => `aioshm-${n}-${tag}`;

/** The diensten listed under "Je hebt N diensten:", before any "Vervallen:" or "Erbij gekomen:". */
function jeDiensten(tekst: string): string[] {
  const kop = tekst.indexOf('Je hebt ');
  const eind = [tekst.indexOf('Vervallen:'), tekst.indexOf('Erbij gekomen:'), tekst.length].filter((i) => i > kop).sort((a, b) => a - b)[0];
  return tekst
    .slice(kop, eind)
    .split('\n')
    .filter((r) => r.startsWith('- '));
}
const DAG = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const MAAND = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const CODE_NAAM: Record<string, string> = { UD: 'uitloopdienst', DD: 'dagdienst', AD: 'avonddienst', ADW: 'avonddienst weekend', ND: 'nachtdienst' };
function mailRegel(datum: string, code: string): string {
  const d = new Date(`${datum}T12:00:00Z`);
  return `- ${DAG[d.getUTCDay()]} ${d.getUTCDate()} ${MAAND[d.getUTCMonth()]} ${d.getUTCFullYear()}: ${CODE_NAAM[code]}`;
}

function mail(): Map<string, string> {
  expect(sink.received).toHaveLength(1);
  const lijst = verzendlijstPayload(sink.received[0].raw);
  return new Map(lijst.berichten.map((b) => [b.codenaam, b.tekst]));
}

async function mijn(personId: string): Promise<string[][]> {
  const res = await mijnRooster(
    new NextRequest(`http://localhost/api/aios/deelnemer/${personId}/periode/${w.period}/rooster`, { headers: { cookie: personCookie(personId) } }),
    { params: Promise.resolve({ id: personId, periodId: w.period }) }
  );
  expect(res.status).toBe(200);
  return (await res.json()).data.diensten.map((d: { datum: string; code: string }) => [d.datum, d.code]);
}

/** Every channel shows the diensten of each AIOS as they are in the database. */
function controleerMail(berichten: Map<string, string>) {
  for (const n of ['x', 'y', 'z']) {
    expect([...jeDiensten(berichten.get(naam(n))!)].sort(), `mail van ${n}`).toEqual(eigen(naam(n)).map(([datum, code]) => mailRegel(datum, code)).sort());
  }
}
async function controleerPagina() {
  for (const [n, id] of [
    ['x', w.x],
    ['y', w.y],
    ['z', w.z],
  ] as const) {
    const op = (a: string[][]) => a.map((d) => d.join(' ')).sort();
    expect(op(await mijn(id)), `pagina van ${n}`).toEqual(op(eigen(naam(n)).map(([datum, code]) => [datum, code])));
  }
}
async function controleerExcel() {
  const res = await downloadRooster(req(`${w.period}/download`), ctx(w.period));
  expect(res.status).toBe(200);
  const [, ...rijen] = readFirstSheet(Buffer.from(await res.arrayBuffer()));
  const kolom: Record<string, number> = { UD: 4, DD: 5, AD: 6, ADW: 6, ND: 7 };
  const verwacht = new Map<string, string>();
  for (const [datum, code, wie] of werkelijk()) verwacht.set(`${datum}|${kolom[code]}`, wie);
  for (const r of rijen) {
    const datum = excelSerialToDate(Number(r[0]));
    for (const k of [4, 5, 6, 7]) expect(r[k] || undefined, `${datum} kolom ${k}`).toBe(verwacht.get(`${datum}|${k}`));
  }
  // The counts on the planner's page (what the table "Dienstdoende" shows) follow a change by hand too.
  const perAios = laadAiosRooster(aiosUitnodigPeriode(w.period)!).per_aios;
  for (const n of ['x', 'y', 'z']) {
    const rij = perAios.find((r) => r.codenaam === naam(n))!;
    const mijnDiensten = eigen(naam(n));
    const tel = (...codes: string[]) => mijnDiensten.filter((d) => codes.includes(d[1])).length;
    expect(rij.nachten, `nachten van ${n}`).toBe(tel('ND'));
    expect(rij.avonden, `avonden van ${n}`).toBe(tel('AD', 'ADW'));
    expect(rij.uitloopdiensten, `uitloopdiensten van ${n}`).toBe(tel('UD'));
  }
}

beforeAll(async () => {
  snapshot = rowidSnapshot();
  sink = await startSmtpSink();
  configureSmtp(sink, { aan: 'stroom@example.test' });
  buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  bewaarAiosStroomAdres(AAN_AIOS, w.planner);
  process.env.BASE_URL = 'http://localhost:3000';
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosHm-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosHm-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  w.period = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `AiosHm-${tag}`,
    start_datum: START,
    eind_datum: EIND,
    deadline: '2094-05-01T17:00',
    status: 'GEGENEREERD',
    auto_herinneren: 0,
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(w.period, aiosShiftTypes(w.pool)!, START, EIND))();
  const deelnemer = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: naam(n), rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
  w.z = deelnemer('z');
  for (const id of [w.x, w.y, w.z]) aiosPersoonlijkeLink(id, w.period, 'http://localhost:3000');
  // The roster the solver made: x the night block wo t/m vr, z one evening, everything else y.
  const xNacht = new Set(['2094-07-07', '2094-07-08', '2094-07-09']);
  for (const s of slots()) {
    const wie = s.code === 'ND' && xNacht.has(s.datum) ? w.x : s.code === 'AD' && s.datum === '2094-07-14' ? w.z : w.y;
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

describe('changed by hand before publishing', () => {
  it('the voorlopig mail and the AIOS page show the changed roster', async () => {
    const solver = werkelijk();
    // A night out of x's block to z, and z's evening to x.
    await geef('ND', '2094-07-08', w.z, w.x);
    await geef('AD', '2094-07-14', w.x, w.z);
    expect(werkelijk()).not.toEqual(solver);
    expect((await doe(publiceren, 'publiceren')).status).toBe(200);
    const berichten = mail();
    expect(jeDiensten(berichten.get(naam('x'))!)).toContain(mailRegel('2094-07-14', 'AD'));
    expect(jeDiensten(berichten.get(naam('x'))!)).not.toContain(mailRegel('2094-07-08', 'ND'));
    expect(jeDiensten(berichten.get(naam('z'))!)).toEqual([mailRegel('2094-07-08', 'ND')]);
    controleerMail(berichten);
    await controleerPagina();
  });
});

describe('changed by hand after publishing voorlopig', () => {
  it('the definitief mail, the page and both downloads show the final roster', async () => {
    // With a reason now: the evening goes from x to y, the night back to x.
    await geef('AD', '2094-07-14', w.y, w.x, 'x heeft onderwijs');
    await geef('ND', '2094-07-08', w.x, w.z, 'terug naar het blok');
    expect((await doe(definitief, 'definitief-maken')).status).toBe(200);
    const berichten = mail();
    controleerMail(berichten);
    expect(jeDiensten(berichten.get(naam('x'))!)).toEqual(['2094-07-07', '2094-07-08', '2094-07-09'].map((d) => mailRegel(d, 'ND')));
    expect(jeDiensten(berichten.get(naam('z'))!)).toEqual([]);
    expect(jeDiensten(berichten.get(naam('y'))!)).toContain(mailRegel('2094-07-14', 'AD'));
    await controleerPagina();
    await controleerExcel();
  });

  it('a change on the definitief roster shows in the page and the downloads too', async () => {
    await geef('UD', '2094-07-12', w.z, w.y, 'bijgesprongen');
    expect(eigen(naam('z')).map((d) => d[1])).toEqual(['UD']);
    await controleerPagina();
    await controleerExcel();
  });
});
