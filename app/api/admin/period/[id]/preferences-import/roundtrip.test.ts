import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fc from 'fast-check';
import crypto from 'crypto';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import { validateCodenaam } from '@/lib/codenaam';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { buildXlsx } from '@/tests/fixtures/buildXlsx';
import { POST as importPreferences } from './route';
import { GET as exportPreferences } from '../../../../exports/preferences/[period-id]/route';

/**
 * The rule: the preferences overview, downloaded and read back unchanged,
 * changes nothing - for any codenamen the app accepts and any markings.
 *
 * route.test.ts proves it for one fixed fixture. Here the codenamen and the
 * markings are generated: names with spaces, accents, quotes, semicolons
 * (the export's separator), and names starting with a character a
 * spreadsheet reads as a formula - the export guards those with an
 * apostrophe (lib/csv.ts), which Excel keeps as part of the text when it
 * opens a CSV. The file then goes the way it goes in practice: opened in
 * Excel, dates and weeks turned into numbers, saved as .xlsx, imported.
 */

type Grid = Array<Array<string | number | null>>;
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const LEVELS = [null, 'LIEVER_NIET', 'ABSOLUUT', 'VOORKEUR'] as const;
let rowidsBefore: Map<string, number>;
let admin = '';

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

function req(url: string, method = 'GET', body?: unknown): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: admin, sessionVersion: getSessionVersion(admin)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A ;-separated CSV as a spreadsheet reads it: quotes and doubled quotes undone, text otherwise kept as it is. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ';') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

const serial = (datum: string) => (Date.parse(`${datum}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;

async function roundTrip(codenamen: string[], marks: number[]): Promise<{ status: number; body: any }> {
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Rondgang', config_json: '{}', aangemaakt_op: now });
  const pool = insert('dienstrooster_pool', { naam: 'Rondgang', ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: pool, naam: 'Avond', teller: 'AVOND' });
  const period = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: 'Rondgang',
    start_datum: '2027-01-04',
    eind_datum: '2027-01-10',
    deadline: '2099-01-01T00:00',
    status: 'OPEN',
    bevroren_ruleset_json: '{}',
    aangemaakt_op: now,
  });
  const slots = generateSlotsForPeriod({ startDate: '2027-01-04', endDate: '2027-01-10', shiftTypes: ['AVOND'] }).map((s) =>
    insert('dienstrooster_shift_slot', {
      period_id: period,
      shift_type_id: avond,
      datum: s.datum,
      iso_jaar: s.iso_jaar,
      iso_week: s.iso_week,
      is_feestdag: s.is_feestdag ? 1 : 0,
      benodigd_aantal_personen: 1,
    })
  );
  let m = 0;
  for (const codenaam of codenamen) {
    const person = insert('dienstrooster_person', { codenaam, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: person, pool_id: pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2030-12-31' });
    for (const slot of slots) {
      const level = LEVELS[marks[m++ % marks.length] % LEVELS.length];
      if (level) insert('dienstrooster_availability', { person_id: person, slot_id: slot, blocking_level: level, source: 'MANUAL', aangemaakt_op: now });
    }
  }

  const res = await (exportPreferences as unknown as Handler)(req(`/api/exports/preferences/${period}`), { params: Promise.resolve({ 'period-id': period }) });
  expect(res.status).toBe(200);
  const grid: Grid = parseCsv((await res.text()).replace(/^﻿/, '')).map((cells, i) =>
    i === 0 ? cells : cells.map((c, col) => (col === 0 ? serial(c) : col === 2 ? Number(c) : c))
  );
  const bestand = buildXlsx(grid, { deflate: true }).toString('base64');
  const imported = await (importPreferences as unknown as Handler)(req(`/api/admin/period/${period}/preferences-import`, 'POST', { bestand, toepassen: false }), {
    params: Promise.resolve({ id: period }),
  });
  return { status: imported.status, body: await imported.json() };
}

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  admin = insert('dienstrooster_person', { codenaam: `Rondgang-admin-${crypto.randomUUID().slice(0, 6)}`, rol: 'ADMIN', actief: 1, aangemaakt_op: new Date().toISOString() });
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

/** A codenaam the app accepts, made unique in the database by a suffix. */
const codenaamArb = (lead: fc.Arbitrary<string>) =>
  fc
    .tuple(lead, fc.stringMatching(/^[A-Za-zÀ-ÿ0-9 ;"'.-]{1,10}$/))
    .map(([l, body]) => `${l}${body.trim()}-${crypto.randomUUID().slice(0, 4)}`)
    .filter((naam) => validateCodenaam(naam).valid && !/^[\d=+\-@]/.test(naam));

describe('preferences overview: download, open in Excel, save, read back', () => {
  it('changes nothing for any codenamen and markings that do not look like a formula', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(codenaamArb(fc.constantFrom('', 'P', 'Ö')), { minLength: 1, maxLength: 4, selector: (n) => n.toLowerCase() }),
        fc.array(fc.nat(3), { minLength: 1, maxLength: 28 }),
        async (codenamen, marks) => {
          const result = await roundTrip(codenamen, marks);
          expect(result.status, JSON.stringify(result.body)).toBe(200);
          expect(result.body.data.problemen).toEqual([]);
          expect(result.body.data.wijzigingen).toEqual([]);
        }
      ),
      { numRuns: 40, seed: 11 }
    );
  }, 120_000);

  // Audit 7: a codenaam may start with -, + or = (validateCodenaam only
  // refuses @). The export guards such a name with a leading apostrophe,
  // Excel keeps it, and the import looks for a participant called
  // "'-Anna": "geen deelnemer met deze codenaam", and the whole file is
  // refused.
  it.fails('changes nothing when a codenaam starts with a character a spreadsheet reads as a formula', async () => {
    const result = await roundTrip([`-Anna-${crypto.randomUUID().slice(0, 4)}`, `Bert-${crypto.randomUUID().slice(0, 4)}`], [1, 0, 2]);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data.problemen).toEqual([]);
  });
});
