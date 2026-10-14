import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { readFirstSheet, readPart } from '@/lib/xlsx';
import { GET } from './route';

/**
 * The hard rules: one row per slot of this period, one column per
 * participant, every marking in words in the right cell with why it is
 * there, an empty cell where nothing was marked - and nothing from another
 * period. Only a planner may download it. It is a workbook, the date a
 * real date (lib/xlsxWrite.ts).
 */

const createdPeriodIds: string[] = [];
const createdPoolIds: string[] = [];
const createdRulesetIds: string[] = [];
const createdPersonIds: string[] = [];
const createdShiftTypeIds: string[] = [];

function createPool(): string {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Test ruleset', JSON.stringify({}));
  createdRulesetIds.push(rulesetId);

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Test pool', rulesetId);
  createdPoolIds.push(poolId);
  return poolId;
}

function createPerson(rol: 'DEELNEMER' | 'PLANNER' = 'DEELNEMER'): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`, rol);
  createdPersonIds.push(personId);
  return personId;
}

function createShiftType(poolId: string, teller: 'AVOND' | 'WEEKEND' = 'AVOND'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, ?, ?)`
  ).run(id, poolId, teller === 'AVOND' ? 'Avonddienst' : 'Weekenddienst', teller);
  createdShiftTypeIds.push(id);
  return id;
}

function createPeriod(poolId: string, naam: string, startDatum: string, eindDatum: string): string {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, '2099-01-01T00:00:00Z', 'OPEN', datetime('now'))`
  ).run(periodId, poolId, naam, startDatum, eindDatum);
  createdPeriodIds.push(periodId);
  return periodId;
}

function createSlot(periodId: string, shiftTypeId: string, datum: string, isoWeek = 1): string {
  const slotId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
     VALUES (?, ?, ?, ?, 2027, ?)`
  ).run(slotId, periodId, shiftTypeId, datum, isoWeek);
  return slotId;
}

function mark(
  personId: string,
  slotId: string,
  level: 'ABSOLUUT' | 'LIEVER_NIET' | 'VOORKEUR' | null,
  source: 'MANUAL' | 'PARTTIME' | 'ABSENCE' = 'MANUAL',
  fellow = false
): void {
  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, fellow_blok, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId, level, source, fellow ? 1 : 0);
}

function join(personId: string, poolId: string): void {
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, 1, '2026-01-01', '2099-12-31')`
  ).run(crypto.randomUUID(), personId, poolId);
}

const fromSerial = (serial: string) => new Date(Date.UTC(1899, 11, 30) + Number(serial) * 86400000).toISOString().slice(0, 10);

/**
 * The workbook's rows as text, every row as wide as the header (the reader
 * leaves trailing empty cells out) and the dates, which Excel stores as
 * day numbers, as YYYY-MM-DD again.
 */
async function grid(periodId: string, plannerId: string): Promise<string[][]> {
  const rows = readFirstSheet(Buffer.from(await exportBytes(periodId, plannerId)));
  return rows.map((cells, i) =>
    Array.from({ length: rows[0].length }, (_, c) => (i > 0 && c === 0 ? fromSerial(cells[0]) : (cells[c] ?? '')))
  );
}

function codenaam(personId: string): string {
  return (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(personId) as { codenaam: string })
    .codenaam;
}

function plannerRequest(periodId: string, personId: string): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId, sessionVersion: getSessionVersion(personId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost/api/exports/preferences/${periodId}`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

async function exportBytes(periodId: string, plannerId: string): Promise<Uint8Array> {
  const res = await GET(plannerRequest(periodId, plannerId), {
    params: Promise.resolve({ 'period-id': periodId }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return new Uint8Array(await res.arrayBuffer());
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare(
      'DELETE FROM dienstrooster_availability WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)'
    ).run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  while (createdShiftTypeIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE id = ?').run(createdShiftTypeIds.pop()!);
  }
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
  while (createdPoolIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(createdPoolIds.pop()!);
  }
  while (createdRulesetIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(createdRulesetIds.pop()!);
  }
});

describe('GET /api/exports/preferences/[period-id]', () => {
  it('puts every marking in its day row and person column, in words', async () => {
    const poolId = createPool();
    const avond = createShiftType(poolId, 'AVOND');
    const weekend = createShiftType(poolId, 'WEEKEND');
    const planner = createPerson('PLANNER');
    const a = createPerson();
    const b = createPerson();
    const leeg = createPerson();
    [a, b, leeg].forEach((p) => join(p, poolId));
    const periodId = createPeriod(poolId, 'Voorjaar 2027', '2027-01-04', '2027-01-17');

    const maandag = createSlot(periodId, avond, '2027-01-04', 1);
    const dinsdag = createSlot(periodId, avond, '2027-01-05', 1);
    const zaterdag = createSlot(periodId, weekend, '2027-01-09', 1);
    const woensdag = createSlot(periodId, avond, '2027-01-13', 2);
    const donderdag = createSlot(periodId, avond, '2027-01-14', 2);

    mark(a, maandag, 'ABSOLUUT', 'PARTTIME');
    mark(a, dinsdag, 'LIEVER_NIET');
    mark(a, zaterdag, 'ABSOLUUT', 'MANUAL', true);
    mark(b, woensdag, 'VOORKEUR');
    mark(b, donderdag, 'ABSOLUUT', 'ABSENCE');
    mark(b, maandag, null);

    const rows = await grid(periodId, planner);
    const header = rows[0];
    expect(header.slice(0, 4)).toEqual(['Datum', 'Dag', 'Week', 'Dienst']);
    const col = (personId: string) => header.indexOf(codenaam(personId));
    const row = (datum: string) => rows.find((r) => r[0] === datum)!;

    // Every slot a row, in date order; everyone in the pool a column.
    expect(rows.slice(1).map((r) => r[0])).toEqual(['2027-01-04', '2027-01-05', '2027-01-09', '2027-01-13', '2027-01-14']);
    expect(col(leeg)).toBeGreaterThan(3);
    expect(row('2027-01-09').slice(0, 4)).toEqual(['2027-01-09', 'zaterdag', '1', 'weekenddienst']);

    expect(row('2027-01-04')[col(a)]).toBe('geblokkeerd (parttime)');
    expect(row('2027-01-05')[col(a)]).toBe('liever niet');
    expect(row('2027-01-09')[col(a)]).toBe('geblokkeerd (fellow)');
    expect(row('2027-01-13')[col(b)]).toBe('voorkeur');
    expect(row('2027-01-14')[col(b)]).toBe('geblokkeerd (afwezig)');

    // Nothing marked, or marked back to neutral: an empty cell.
    expect(row('2027-01-04')[col(b)]).toBe('');
    expect(row('2027-01-13')[col(a)]).toBe('');
    expect(rows.slice(1).every((r) => r[col(leeg)] === '')).toBe(true);
  });

  it('holds the date as a date and keeps the first four columns in view and on paper', async () => {
    const poolId = createPool();
    const avond = createShiftType(poolId, 'AVOND');
    const planner = createPerson('PLANNER');
    join(createPerson(), poolId);
    const periodId = createPeriod(poolId, 'Voorjaar 2027', '2027-01-04', '2027-01-17');
    createSlot(periodId, avond, '2027-01-04', 1);

    const book = Buffer.from(await exportBytes(periodId, planner));
    const sheet = readPart(book, 'xl/worksheets/sheet1.xml')!;
    // 46391 is 4 January 2027; style 2 is the date format.
    expect(sheet).toContain('<c r="A2" s="2"><v>46391</v></c>');
    expect(sheet).toContain('<pane xSplit="4" ySplit="1"');
    expect(sheet).toContain('<printOptions gridLines="1"/>');
    expect(readPart(book, 'xl/workbook.xml')).toContain("'Voorkeuren'!$A:$D,'Voorkeuren'!$1:$1");
  });

  // Reported by the planner: someone removed from the pool after marking
  // days kept their column, because the export also listed anyone with a
  // marking. The solver only looks at the period's members, so that column
  // showed preferences nobody would ever act on.
  it('leaves out someone who is no longer in the pool, markings or not', async () => {
    const poolId = createPool();
    const avond = createShiftType(poolId, 'AVOND');
    const planner = createPerson('PLANNER');
    const blijft = createPerson();
    const weg = createPerson();
    [blijft, weg].forEach((p) => join(p, poolId));
    const periodId = createPeriod(poolId, 'Voorjaar 2027', '2027-01-04', '2027-01-17');
    const maandag = createSlot(periodId, avond, '2027-01-04', 1);
    mark(weg, maandag, 'ABSOLUUT');
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(weg);

    const header = (await grid(periodId, planner))[0];
    expect(header).toContain(codenaam(blijft));
    expect(header).not.toContain(codenaam(weg));
  });

  it('shows nothing from another period', async () => {
    const poolId = createPool();
    const avond = createShiftType(poolId);
    const planner = createPerson('PLANNER');
    const person = createPerson();
    join(person, poolId);
    const periodA = createPeriod(poolId, 'Periode A', '2027-01-04', '2027-01-17');
    const periodB = createPeriod(poolId, 'Periode B', '2027-02-01', '2027-02-14');

    createSlot(periodA, avond, '2027-01-05');
    mark(person, createSlot(periodB, avond, '2027-02-02'), 'ABSOLUUT');

    const rows = await grid(periodA, planner);
    expect(rows.map((r) => r[0])).toEqual(['Datum', '2027-01-05']);
    expect(rows[1][rows[0].indexOf(codenaam(person))]).toBe('');
  });

  it('is refused to a participant', async () => {
    const poolId = createPool();
    const person = createPerson();
    const periodId = createPeriod(poolId, 'Periode', '2027-01-04', '2027-01-17');

    const res = await GET(plannerRequest(periodId, person), {
      params: Promise.resolve({ 'period-id': periodId }),
    });
    expect(res.status).toBe(401);
  });
});
