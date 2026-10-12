import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { validateSingleLine, PERIODE_NAAM_MAX_LENGTH } from '@/lib/vrijeTekst';
import { GET as assignments } from './assignments/[period-id]/route';
import { GET as auditTrail } from './audit-trail/[period-id]/route';
import { POST as invitations } from './invitations/[period-id]/route';
import { GET as preferences } from './preferences/[period-id]/route';
import { GET as statusReport } from './status-report/[period-id]/route';

/**
 * The rule: any name a period may get, every export of it downloads.
 *
 * The period's name goes into the download's file name, in the
 * Content-Disposition header. A header value may only hold characters up
 * to U+00FF, and the name check (validateSingleLine) lets through anything
 * that is not a control or invisible character - an en dash that Word or
 * a Mac types for "2027 - 2028", a euro sign, an emoji.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const EXPORTS: Array<[string, unknown, 'GET' | 'POST']> = [
  ['diensten', assignments, 'GET'],
  ['wijzigingsgeschiedenis', auditTrail, 'GET'],
  // POST: it mints a fresh personal link per participant before answering.
  ['uitnodigingen', invitations, 'POST'],
  ['voorkeuren', preferences, 'GET'],
  ['status', statusReport, 'GET'],
];

const NAMES = ['Voorjaar 2027', 'Café-periode é', 'Voorjaar 2027 – 2028', 'Kerst €', 'Zomer ☀️'];

let rowidsBefore: Map<string, number>;
const ids: Record<string, string> = {};
let cookie = '';

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

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Export', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Export', ruleset_id: ruleset, aangemaakt_op: now });
  ids.avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  ids.person = insert('dienstrooster_person', { codenaam: `Export-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  insert('dienstrooster_pool_membership', { person_id: ids.person, pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  ids.planner = insert('dienstrooster_person', { codenaam: `Export-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
  const token = createSessionToken(
    { kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

function periodNamed(naam: string): string {
  const now = new Date().toISOString();
  const period = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam,
    start_datum: '2099-03-02',
    eind_datum: '2099-03-08',
    deadline: '2099-01-01T00:00',
    status: 'GEPUBLICEERD',
    bevroren_ruleset_json: '{"windowWeeks":2}',
    aangemaakt_op: now,
  });
  const slot = insert('dienstrooster_shift_slot', {
    period_id: period,
    shift_type_id: ids.avond,
    datum: '2099-03-02',
    iso_jaar: 2099,
    iso_week: 9,
    is_feestdag: 0,
    benodigd_aantal_personen: 1,
  });
  insert('dienstrooster_assignment', { schedule_version_id: period, person_id: ids.person, slot_id: slot, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  return period;
}

describe('every export downloads, whatever the period is called', () => {
  it('the names used below are names a period may get', () => {
    for (const naam of NAMES) expect(validateSingleLine(naam, 'Naam', PERIODE_NAAM_MAX_LENGTH)).toMatchObject({ valid: true });
  });

  // Audit 7: the three names with a character above U+00FF answered 500 on
  // every export - "Cannot convert argument to a ByteString" building the
  // Content-Disposition header. Now the header carries an ASCII name and the
  // real one percent-encoded (lib/csv.ts csvAttachment).
  for (const naam of NAMES) {
    for (const [label, handler, method] of EXPORTS) {
      it(`${label}: "${naam}"`, async () => {
        const period = periodNamed(naam);
        const res = await (handler as Handler)(
          new NextRequest(`http://localhost/api/exports/x/${period}`, { method, headers: { Cookie: cookie } }),
          { params: Promise.resolve({ 'period-id': period }) }
        );
        expect(res.status).toBe(200);
        const header = res.headers.get('Content-Disposition')!;
        expect(header).toMatch(/^attachment; filename="[\x20-\x7e]+\.csv"; filename\*=UTF-8''/);
        expect(decodeURIComponent(header.split("UTF-8''")[1])).toContain(naam.replace(/ /g, '_'));
      });
    }
  }
});
