import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { buildXlsx } from '@/tests/fixtures/buildXlsx';
import { readFirstSheet } from '@/lib/xlsx';
import { createRosterGenerationJob, completeRosterGenerationJob } from '@/lib/rosterGenerationJobs';
import { POST } from './route';
import { GET as exportPreferences } from '../../../../exports/preferences/[period-id]/route';

/**
 * The rules: only a beheerder imports; checking changes nothing; the
 * overview read back unchanged changes nothing; hand markings follow the
 * file, while part-time, absence and fellow blocks are never touched; a
 * file with problems is refused whole; a built roster is left alone.
 */

interface Fixture {
  poolId: string;
  rulesetId: string;
  periodId: string;
  people: Array<{ id: string; codenaam: string }>;
  slots: Array<{ id: string; datum: string }>;
  admin: string;
  planner: string;
}

const fixtures: Fixture[] = [];

function staff(rol: 'ADMIN' | 'PLANNER'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(id, `S-${id.slice(0, 8)}`, rol);
  return id;
}

function createFixture(): Fixture {
  const rulesetId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'Test', '{}', datetime('now'))`).run(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Test pool', ?, datetime('now'))`).run(poolId, rulesetId);
  const shiftTypeId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`).run(shiftTypeId, poolId);

  const people = [0, 1].map(() => {
    const id = crypto.randomUUID();
    const codenaam = `Imp-${id.slice(0, 8)}`;
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(id, codenaam);
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
    ).run(crypto.randomUUID(), id, poolId);
    return { id, codenaam };
  });

  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'Importtest', '2027-01-04', '2027-01-10', '2099-01-01T00:00', 'OPEN', '{}', datetime('now'))`
  ).run(periodId, poolId);
  const insert = db.prepare(
    `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id, is_feestdag, feestdag_groep, benodigd_aantal_personen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  const slots = generateSlotsForPeriod({ startDate: '2027-01-04', endDate: '2027-01-10', shiftTypes: ['AVOND'] }).map((s) => {
    const id = crypto.randomUUID();
    insert.run(id, periodId, shiftTypeId, s.datum, s.iso_jaar, s.iso_week, s.weekend_id || null, s.is_feestdag ? 1 : 0, s.feestdag_groep);
    return { id, datum: s.datum };
  });

  const f = { poolId, rulesetId, periodId, people, slots, admin: staff('ADMIN'), planner: staff('PLANNER') };
  fixtures.push(f);
  return f;
}

function mark(personId: string, slotId: string, level: string, source: 'MANUAL' | 'PARTTIME' = 'MANUAL') {
  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op) VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId, level, source);
}

function markings(f: Fixture): Record<string, string> {
  const rows = db
    .prepare(
      `SELECT p.codenaam, s.datum, a.blocking_level, a.source FROM dienstrooster_availability a
       JOIN dienstrooster_person p ON p.id = a.person_id JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       WHERE s.period_id = ?`
    )
    .all(f.periodId) as Array<{ codenaam: string; datum: string; blocking_level: string; source: string }>;
  return Object.fromEntries(rows.map((r) => [`${r.codenaam}|${r.datum}`, `${r.blocking_level}/${r.source}`]));
}

function req(url: string, actorId: string, method = 'GET', body?: unknown) {
  const token = createSessionToken(
    { kind: 'staff', personId: actorId, sessionVersion: getSessionVersion(actorId)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type Grid = Array<Array<string | number | null>>;

const serial = (datum: string) => (Date.parse(`${datum}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;

/** The downloaded overview, the file itself. */
async function download(f: Fixture): Promise<Buffer> {
  const res = await exportPreferences(req(`/api/exports/preferences/${f.periodId}`, f.admin), {
    params: Promise.resolve({ 'period-id': f.periodId }),
  });
  return Buffer.from(await res.arrayBuffer());
}

/** The downloaded overview as Excel holds it: the dates day numbers, the weeks numbers. */
async function exported(f: Fixture): Promise<Grid> {
  const rows = readFirstSheet(await download(f));
  return rows.map((cells, i) => {
    const full: Array<string | number> = Array.from({ length: rows[0].length }, (_, c) => cells[c] ?? '');
    if (i > 0) {
      full[0] = Number(full[0]);
      full[2] = Number(full[2]);
    }
    return full;
  });
}

async function importXlsx(f: Fixture, grid: Grid | Buffer, toepassen: boolean, actor = f.admin) {
  const bestand = (Buffer.isBuffer(grid) ? grid : buildXlsx(grid, { deflate: true })).toString('base64');
  const res = await POST(req(`/api/admin/period/${f.periodId}/preferences-import`, actor, 'POST', { bestand, toepassen }), {
    params: Promise.resolve({ id: f.periodId }),
  });
  return { status: res.status, body: await res.json() };
}

/** The grid with cells filled in, as someone would in Excel. */
function edit(grid: Grid, changes: Array<[datum: string, codenaam: string, value: string]>): Grid {
  const rows = grid.map((r) => [...r]);
  for (const [datum, codenaam, value] of changes) {
    const col = rows[0].indexOf(codenaam);
    const row = rows.find((r) => r[0] === serial(datum))!;
    row[col] = value;
  }
  return rows;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) {
    const ids = [...f.people.map((p) => p.id), f.admin, f.planner];
    db.prepare(`DELETE FROM dienstrooster_availability WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)`).run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_submission WHERE schedule_period_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(f.poolId);
    for (const id of ids) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(f.poolId);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(f.poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(f.rulesetId);
  }
});

describe('POST /api/admin/period/[id]/preferences-import', () => {
  it('is for a beheerder only', async () => {
    const f = createFixture();
    const grid = await exported(f);
    expect((await importXlsx(f, grid, false, f.planner)).status).toBe(401);
    expect((await importXlsx(f, grid, false)).status).toBe(200);
  });

  it('changes nothing when the overview is read back unchanged', async () => {
    const f = createFixture();
    const [a, b] = f.people;
    mark(a.id, f.slots[0].id, 'ABSOLUUT');
    mark(b.id, f.slots[1].id, 'LIEVER_NIET', 'PARTTIME');
    const { body } = await importXlsx(f, await exported(f), false);
    expect(body.data.wijzigingen).toEqual([]);
    expect(body.data.problemen).toEqual([]);
    expect(body.data.overgeslagen).toBe(1);
  });

  // 0.20.0: the overview is a workbook itself, so the downloaded file goes
  // back in as it is, without "Opslaan als" first.
  it('reads the downloaded file itself back, changing nothing', async () => {
    const f = createFixture();
    const [a, b] = f.people;
    mark(a.id, f.slots[0].id, 'VOORKEUR');
    mark(b.id, f.slots[2].id, 'ABSOLUUT', 'PARTTIME');
    const { status, body } = await importXlsx(f, await download(f), false);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.data.problemen).toEqual([]);
    expect(body.data.wijzigingen).toEqual([]);
    expect(body.data.overgeslagen).toBe(1);
  });

  it('sets and clears hand markings, and leaves part-time blocks alone', async () => {
    const f = createFixture();
    const [a, b] = f.people;
    const [d0, d1, d2, d3] = f.slots.map((s) => s.datum);
    mark(a.id, f.slots[0].id, 'ABSOLUUT');
    mark(a.id, f.slots[1].id, 'VOORKEUR');
    mark(b.id, f.slots[2].id, 'ABSOLUUT', 'PARTTIME');
    mark(b.id, f.slots[3].id, 'ABSOLUUT', 'PARTTIME');
    const before = markings(f);

    const grid = edit(await exported(f), [
      [d0, a.codenaam, 'liever niet'], // changed
      [d1, a.codenaam, ''], // cleared
      [d2, a.codenaam, 'Voorkeur'], // new, any case
      [d2, b.codenaam, ''], // empty on a part-time block: stays
      [d3, b.codenaam, 'voorkeur (parttime)'], // automatic cell: skipped
    ]);

    const check = await importXlsx(f, grid, false);
    expect(check.body.data.wijzigingen).toHaveLength(3);
    expect(markings(f)).toEqual(before); // checking changes nothing

    const applied = await importXlsx(f, grid, true);
    expect(applied.body.data.toegepast).toBe(true);
    expect(markings(f)).toEqual({
      [`${a.codenaam}|${d0}`]: 'LIEVER_NIET/MANUAL',
      [`${a.codenaam}|${d2}`]: 'VOORKEUR/MANUAL',
      [`${b.codenaam}|${d2}`]: 'ABSOLUUT/PARTTIME',
      [`${b.codenaam}|${d3}`]: 'ABSOLUUT/PARTTIME',
    });
  });

  it('reads a date typed as text too, ISO or the Dutch way', async () => {
    const f = createFixture();
    const [a] = f.people;
    const grid = edit(await exported(f), [[f.slots[0].datum, a.codenaam, 'geblokkeerd']]);
    grid[1][0] = '4-1-2027';
    grid[2][0] = f.slots[1].datum;
    const { body } = await importXlsx(f, grid, false);
    expect(body.data.problemen).toEqual([]);
    expect(body.data.wijzigingen).toEqual([
      { codenaam: a.codenaam, datum: '2027-01-04', dienst: 'avonddienst', van: 'leeg', naar: 'geblokkeerd' },
    ]);
  });

  it('refuses a file that is not .xlsx, such as the CSV itself', async () => {
    const f = createFixture();
    const res = await importXlsx(f, Buffer.from('Datum;Dag;Week;Dienst\r\n2027-01-04;maandag;1;avonddienst'), false);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('geen Excel-bestand');
  });

  it('refuses a file with problems as a whole', async () => {
    const f = createFixture();
    const [a] = f.people;
    const grid = edit(await exported(f), [
      [f.slots[0].datum, a.codenaam, 'geblokkeerd'],
      [f.slots[1].datum, a.codenaam, 'misschien'],
    ]);
    grid[0].push('Onbekend-99');
    const check = await importXlsx(f, grid, false);
    expect(check.body.data.problemen).toHaveLength(2);
    const applied = await importXlsx(f, grid, true);
    expect(applied.status).toBe(400);
    expect(markings(f)).toEqual({});
  });

  // Audit 13: a codenaam column twice (copied in Excel to fill it in more
  // easily) counted every cell twice and wrote the last of the two; a day
  // twice wrote whichever row came last. The count the planner read, and
  // what landed, depended on the order of the copies.
  it('refuses a codenaam column that appears twice', async () => {
    const f = createFixture();
    const [a] = f.people;
    const grid = edit(await exported(f), [[f.slots[0].datum, a.codenaam, 'geblokkeerd']]);
    const col = grid[0].indexOf(a.codenaam);
    for (const row of grid) row.push(row[col]);
    grid[1][grid[0].length - 1] = 'voorkeur';
    const check = await importXlsx(f, grid, false);
    expect(check.body.data.problemen).toEqual([`Kolom "${a.codenaam}" staat twee keer in het bestand.`]);
    expect((await importXlsx(f, grid, true)).status).toBe(400);
    expect(markings(f)).toEqual({});
  });

  it('refuses a day that appears twice', async () => {
    const f = createFixture();
    const [a] = f.people;
    const grid = edit(await exported(f), [[f.slots[0].datum, a.codenaam, 'geblokkeerd']]);
    const copy = [...grid[1]];
    copy[grid[0].indexOf(a.codenaam)] = 'voorkeur';
    grid.push(copy);
    const check = await importXlsx(f, grid, false);
    expect(check.body.data.problemen).toEqual([`Regel ${grid.length}: de avonddienst op ${f.slots[0].datum} staat ook op regel 2.`]);
    expect((await importXlsx(f, grid, true)).status).toBe(400);
    expect(markings(f)).toEqual({});
  });

  // Audit 13: any participant's codenaam was taken, also someone outside
  // this period's pool or whose Geldig vanaf/tot misses the period. The
  // markings went in and counted as changes, while the overview, the
  // solver and "Status voorkeuren" never see that person.
  it('refuses a column for someone who does not take part in this period', async () => {
    const f = createFixture();
    const outsider = crypto.randomUUID();
    const gone = crypto.randomUUID();
    for (const id of [outsider, gone]) {
      db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(id, `Imp-${id.slice(0, 8)}`);
      f.people.push({ id, codenaam: `Imp-${id.slice(0, 8)}` });
    }
    // A member once, gone before the period starts.
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, '2020-01-01', '2026-12-31')`
    ).run(crypto.randomUUID(), gone, f.poolId);
    const grid = await exported(f);
    for (const id of [outsider, gone]) {
      grid[0].push(`Imp-${id.slice(0, 8)}`);
      grid.slice(1).forEach((row) => row.push('geblokkeerd'));
    }
    const check = await importXlsx(f, grid, false);
    expect(check.body.data.problemen).toEqual([
      `Kolom "Imp-${outsider.slice(0, 8)}": doet niet mee aan deze periode.`,
      `Kolom "Imp-${gone.slice(0, 8)}": doet niet mee aan deze periode.`,
    ]);
    expect(check.body.data.wijzigingen).toEqual([]);
    expect((await importXlsx(f, grid, true)).status).toBe(400);
    expect(markings(f)).toEqual({});
  });

  it('leaves a period whose roster is built alone', async () => {
    const f = createFixture();
    const grid = await exported(f);
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD' WHERE id = ?`).run(f.periodId);
    expect((await importXlsx(f, grid, false)).status).toBe(409);
  });

  // A message points at the row the user sees in Excel: the empty rows in between count.
  it('names the row as Excel numbers it, empty rows counted', async () => {
    const f = createFixture();
    const [a] = f.people;
    const grid = edit(await exported(f), [[f.slots[0].datum, a.codenaam, 'misschien']]);
    grid.splice(1, 0, [], []); // two empty rows between the header and the first day
    const check = await importXlsx(f, grid, false);
    expect(check.body.data.problemen).toEqual([`Regel 4, ${a.codenaam}: "misschien" is geen geblokkeerd, liever niet of voorkeur.`]);
  });

  // The file is a little older than the block: the part-time day was added after the download. The plain word
  // must not turn the part-time block into a hand marking (it would stay when the pattern is removed).
  it('leaves a part-time block alone when the file repeats it as a plain word', async () => {
    const f = createFixture();
    const [, b] = f.people;
    mark(b.id, f.slots[2].id, 'ABSOLUUT', 'PARTTIME');
    const before = markings(f);
    const grid = edit(await exported(f), [[f.slots[2].datum, b.codenaam, 'geblokkeerd']]);
    const check = await importXlsx(f, grid, false);
    expect(check.body.data.wijzigingen).toEqual([]);
    expect(check.body.data.overgeslagen).toBe(1);
    expect((await importXlsx(f, grid, true)).status).toBe(200);
    expect(markings(f)).toEqual(before);
  });

  it('still lets a plain word of another level replace a part-time block', async () => {
    const f = createFixture();
    const [, b] = f.people;
    mark(b.id, f.slots[2].id, 'ABSOLUUT', 'PARTTIME');
    const grid = edit(await exported(f), [[f.slots[2].datum, b.codenaam, 'voorkeur']]);
    const check = await importXlsx(f, grid, false);
    expect(check.body.data.wijzigingen).toEqual([
      { codenaam: b.codenaam, datum: f.slots[2].datum, dienst: 'avonddienst', van: 'geblokkeerd (automatisch)', naar: 'voorkeur' },
    ]);
  });

  it('says so when a column without a name holds markings', async () => {
    const f = createFixture();
    const grid = await exported(f);
    const kolom = grid[0].length; // one past the last codenaam
    grid.forEach((row, r) => {
      row[kolom] = r === 0 ? null : r === 1 ? 'geblokkeerd' : null;
    });
    const check = await importXlsx(f, grid, false);
    expect(check.body.data.problemen).toEqual([
      `Kolom ${kolom + 1} heeft geen kop maar wel gegevens. Zet er de codenaam van een deelnemer boven of haal de kolom weg.`,
    ]);
    expect((await importXlsx(f, grid, true)).status).toBe(400);
  });

  it('is refused while a roster generation runs for the period', async () => {
    const f = createFixture();
    const [a] = f.people;
    const grid = edit(await exported(f), [[f.slots[0].datum, a.codenaam, 'geblokkeerd']]);
    const job = createRosterGenerationJob(f.periodId);
    try {
      const res = await importXlsx(f, grid, true);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('GENERATION_RUNNING');
      expect(markings(f)).toEqual({});
    } finally {
      completeRosterGenerationJob(job, { assignmentsCreated: 0 } as never);
    }
    expect((await importXlsx(f, grid, true)).status).toBe(200);
  });
});
