import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { priorRowsInWindow } from '@/lib/priorAssignmentUpload';
import { buildXlsx } from '@/tests/fixtures/buildXlsx';
import { POST as readWorkbook } from './route';
import { GET as exportRoster } from '../../exports/assignments/[period-id]/route';
import { GET as priorAssignments } from '../../periods/[id]/prior-assignments/route';
import { POST as importPrior } from '../../periods/[id]/prior-assignments/import-csv/route';

/**
 * The rule: the roster a planner downloads goes back into "Eerdere
 * toewijzingen" as it is.
 *
 * The downloads are workbooks since 0.20.0 and that import took CSV only:
 * the roster download of the previous period, the very file the screen
 * asks for, would have been refused unless saved as CSV first. Here it
 * goes the whole way the screen takes it: downloaded, read by this route,
 * previewed by lib/priorAssignmentUpload.ts, imported - across the year
 * boundary, with a codenaam starting with a minus.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;

function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

function insert(table: string, row: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const cols = ['id', ...Object.keys(row)];
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
    id,
    ...Object.values(row).map((v) => v as never)
  );
  return id;
}

function req(url: string, personId: string, kind: 'staff' | 'person' = 'staff', body?: unknown): NextRequest {
  const token = createSessionToken({ kind, personId, sessionVersion: getSessionVersion(personId)! } as never, STAFF_SESSION_MAX_AGE_SECONDS);
  return new NextRequest(`http://localhost${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function read(bestand: unknown, personId = ids.planner, kind: 'staff' | 'person' = 'staff') {
  const res = await readWorkbook(req('/api/planner/read-workbook', personId, kind, { bestand }));
  return { status: res.status, body: await res.json() };
}

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Werkmap', config_json: '{}', aangemaakt_op: now });
  const pool = insert('dienstrooster_pool', { naam: 'Werkmap', ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: pool, naam: 'Avond', teller: 'AVOND' });
  const weekend = insert('dienstrooster_shift_type', { pool_id: pool, naam: 'Weekend', teller: 'WEEKEND' });
  ids.previous = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: 'Najaar 2026',
    start_datum: '2026-12-14',
    eind_datum: '2027-01-03',
    deadline: '2026-11-01T12:00',
    status: 'GEPUBLICEERD',
    bevroren_ruleset_json: JSON.stringify({ windowWeeks: 2 }),
    aangemaakt_op: now,
  });
  ids.next = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: 'Voorjaar 2027',
    start_datum: '2027-01-04',
    eind_datum: '2027-01-31',
    deadline: '2099-01-01T12:00',
    status: 'OPEN',
    bevroren_ruleset_json: JSON.stringify({ windowWeeks: 2 }),
    aangemaakt_op: now,
  });
  ids.planner = insert('dienstrooster_person', { codenaam: `Werkmap-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
  ids.participant = insert('dienstrooster_person', { codenaam: `Werkmap-deelnemer-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  insert('dienstrooster_person_access_link', { person_id: ids.participant, token_hash: crypto.randomUUID(), aangemaakt_op: now });
  ids.minus = insert('dienstrooster_person', { codenaam: `-Anna-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  ids.plain = insert('dienstrooster_person', { codenaam: `Bert-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  for (const person of [ids.minus, ids.plain]) {
    insert('dienstrooster_pool_membership', { person_id: person, pool_id: pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
  // The previous roster's last weeks, one shift each across the year boundary.
  const shifts: Array<[string, string, number, number, string]> = [
    ['2026-12-15', avond, 2026, 51, ids.plain],
    ['2026-12-29', avond, 2026, 53, ids.minus],
    ['2027-01-02', weekend, 2026, 53, ids.plain],
  ];
  for (const [datum, type, jaar, week, person] of shifts) {
    const slot = insert('dienstrooster_shift_slot', { period_id: ids.previous, shift_type_id: type, datum, iso_jaar: jaar, iso_week: week, is_feestdag: 0, benodigd_aantal_personen: 1 });
    insert('dienstrooster_assignment', { schedule_version_id: ids.previous, person_id: person, slot_id: slot, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  }
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('the roster download, back into "Eerdere toewijzingen"', () => {
  it('goes in as downloaded, every shift of the window on its own day', async () => {
    const download = await (exportRoster as unknown as Handler)(req(`/api/exports/assignments/${ids.previous}`, ids.planner), {
      params: Promise.resolve({ 'period-id': ids.previous }),
    });
    expect(download.status).toBe(200);
    const { status, body } = await read(Buffer.from(await download.arrayBuffer()).toString('base64'));
    expect(status, JSON.stringify(body)).toBe(200);

    const window = await (priorAssignments as unknown as Handler)(req(`/api/periods/${ids.next}/prior-assignments`, ids.planner), {
      params: Promise.resolve({ id: ids.next }),
    });
    const range = (await window.json()).data.date_range as [string, string];
    expect(range).toEqual(['2026-12-28', '2027-01-03']);

    const preview = priorRowsInWindow(body.data.rows, range);
    expect(preview.warnings).toEqual([]);
    expect(preview.outOfRange).toBe(1);
    const codenaam = (id: string) => (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(id) as { codenaam: string }).codenaam;
    expect(preview.rows).toEqual([
      { datum: '2026-12-29', teller: 'AVOND', codenaam: codenaam(ids.minus) },
      { datum: '2027-01-02', teller: 'WEEKEND', codenaam: codenaam(ids.plain) },
    ]);

    const imported = await (importPrior as unknown as Handler)(req(`/api/periods/${ids.next}/prior-assignments/import-csv`, ids.planner, 'staff', { rows: preview.rows }), {
      params: Promise.resolve({ id: ids.next }),
    });
    expect(imported.status).toBe(200);
    expect((await imported.json()).data).toMatchObject({ imported: 2, errors: [] });
    expect(
      db.prepare('SELECT datum, teller, person_id FROM dienstrooster_prior_assignment WHERE period_id = ? ORDER BY datum').all(ids.next)
    ).toEqual([
      { datum: '2026-12-29', teller: 'AVOND', person_id: ids.minus },
      { datum: '2027-01-02', teller: 'WEEKEND', person_id: ids.plain },
    ]);
  });

  it('reads a workbook Excel saved itself: text dates and day numbers alike', async () => {
    const book = buildXlsx(
      [
        ['Datum', 'Week', 'Diensttype', 'Codenaam'],
        [46384, 53, 'Avond', 'Bert'],
        ['29-12-2026', 53, 'avonddienst', 'Bert'],
      ],
      { deflate: true }
    );
    const { status, body } = await read(book.toString('base64'));
    expect(status).toBe(200);
    expect(priorRowsInWindow(body.data.rows, ['2026-12-28', '2027-01-03']).rows).toEqual([
      { datum: '2026-12-28', teller: 'AVOND', codenaam: 'Bert' },
      { datum: '2026-12-29', teller: 'AVOND', codenaam: 'Bert' },
    ]);
  });
});

describe('POST /api/planner/read-workbook', () => {
  it('is for a planner only', async () => {
    const book = buildXlsx([['a']]).toString('base64');
    expect((await read(book, ids.participant, 'person')).status).toBe(401);
    const anonymous = await readWorkbook(
      new NextRequest('http://localhost/api/planner/read-workbook', { method: 'POST', body: JSON.stringify({ bestand: book }) })
    );
    expect(anonymous.status).toBe(401);
  });

  it('refuses what is not a workbook with a Dutch message, and no file at all', async () => {
    const csv = await read(Buffer.from('Datum;Week;Diensttype;Codenaam\n2026-12-29;53;Avond;Bert').toString('base64'));
    expect(csv.status).toBe(400);
    expect(csv.body.error.message).toBe('Dit is geen Excel-bestand (.xlsx).');
    for (const bestand of [undefined, '', 42, ['x'], { a: 1 }]) {
      const res = await read(bestand);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Kies eerst een Excel-bestand.');
    }
  });
});
