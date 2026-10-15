import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { readFirstSheet } from '@/lib/xlsx';
import { GET as progressRoute } from '@/app/api/planner/period/[id]/progress/route';
import { GET as statusReportRoute } from '@/app/api/exports/status-report/[period-id]/route';

/**
 * The rule: "Status voorkeuren" on the period page and the statusrapport
 * download say the same about everyone (lib/periodProgress.ts), and part-time
 * counts only for a pattern that overlaps the period.
 *
 * The download counted a fellow's weekend blocks as days they blocked
 * themselves, and both put a tick under Deeltijd for a pattern that ended
 * before the period began (audit 16).
 *
 * Period 2099-03-02 (Monday) to 2099-03-15 (Sunday).
 */

const tag = crypto.randomUUID().slice(0, 6);
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

const now = new Date().toISOString();
const slotOn = new Map<string, string>();

function person(naam: string, opts: { vanaf?: string; tot?: string; actief?: number } = {}): string {
  const id = insert('dienstrooster_person', { codenaam: `${naam}-${tag}`, rol: 'DEELNEMER', actief: opts.actief ?? 1, aangemaakt_op: now });
  insert('dienstrooster_pool_membership', {
    person_id: id,
    pool_id: ids.pool,
    deelnamefactor: 1,
    geldig_vanaf: opts.vanaf ?? '2099-01-01',
    geldig_tot: opts.tot ?? '2099-12-31',
  });
  return id;
}

function pattern(personId: string, vanaf: string, tot: string): void {
  insert('dienstrooster_parttime_pattern', {
    person_id: personId,
    weekdag: 'MA',
    frequentie: 'ELKE_WEEK',
    geldig_vanaf: vanaf,
    geldig_tot: tot,
    aangemaakt_door: ids.planner,
    aangemaakt_op: now,
  });
}

function block(personId: string, datum: string, fellowBlok: 0 | 1): void {
  insert('dienstrooster_availability', {
    person_id: personId,
    slot_id: slotOn.get(datum)!,
    blocking_level: 'ABSOLUUT',
    source: 'MANUAL',
    fellow_blok: fellowBlok,
    aangemaakt_op: now,
  });
}

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const ruleset = insert('dienstrooster_ruleset', { naam: `Voortgang-${tag}`, config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: `Voortgang-${tag}`, ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: `Voortgang-${tag}`,
    start_datum: '2099-03-02',
    eind_datum: '2099-03-15',
    deadline: '2099-02-20T23:59',
    status: 'OPEN',
    bevroren_ruleset_json: '{"windowWeeks":1}',
    aangemaakt_op: now,
  });
  for (let d = 2; d <= 15; d++) {
    const datum = `2099-03-${String(d).padStart(2, '0')}`;
    const week = d <= 8 ? 10 : 11;
    slotOn.set(datum, insert('dienstrooster_shift_slot', { period_id: ids.period, shift_type_id: avond, datum, iso_jaar: 2099, iso_week: week }));
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Voortgang-planner-${tag}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });

  // Part-time that ended the day before the period: not part-time in it.
  ids.voor = person('Voor');
  pattern(ids.voor, '2099-01-01', '2099-03-01');
  // Part-time from the period's last day: part-time in it.
  ids.laatste = person('Laatste');
  pattern(ids.laatste, '2099-03-15', '2099-06-30');
  insert('dienstrooster_submission', {
    person_id: ids.laatste,
    schedule_period_id: ids.period,
    status: 'BEVESTIGD',
    ingediend_op: '2099-02-10T09:00:00.000Z',
    deeltijd_gecontroleerd_op: '2099-02-10T08:55:00.000Z',
    aangemaakt_op: now,
  });
  // A fellow: four weekend days blocked by the tick, one weekday by hand.
  ids.fellow = person('Aa-fellow');
  insert('dienstrooster_period_fellow', { period_id: ids.period, person_id: ids.fellow, aangemaakt_op: now });
  for (const datum of ['2099-03-07', '2099-03-08', '2099-03-14', '2099-03-15']) block(ids.fellow, datum, 1);
  block(ids.fellow, '2099-03-04', 0);
  // Not in the period: left the day before, or switched off.
  person('Weg', { tot: '2099-03-01' });
  person('Uit', { actief: 0 });

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

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers: { cookie } });
}

interface ProgressRow {
  codenaam: string;
  submission_status: string | null;
  blocked_days_count: number;
  has_parttime_patterns: number;
  deeltijd_gecontroleerd_op: string | null;
  is_fellow: number;
}

async function progress(): Promise<ProgressRow[]> {
  const res = await progressRoute(request(`/api/planner/period/${ids.period}/progress`), {
    params: Promise.resolve({ id: ids.period }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

async function statusReport(): Promise<string[][]> {
  const res = await statusReportRoute(request(`/api/exports/status-report/${ids.period}`), {
    params: Promise.resolve({ 'period-id': ids.period }),
  });
  expect(res.status).toBe(200);
  return readFirstSheet(Buffer.from(await res.arrayBuffer()));
}

describe('Status voorkeuren and the statusrapport', () => {
  it('lists the period participants, fellows last', async () => {
    const rows = await progress();
    expect(rows.map((r) => r.codenaam)).toEqual([`Laatste-${tag}`, `Voor-${tag}`, `Aa-fellow-${tag}`]);
  });

  it('counts part-time only for a pattern that overlaps the period', async () => {
    const byName = new Map((await progress()).map((r) => [r.codenaam, r]));
    expect(byName.get(`Voor-${tag}`)!.has_parttime_patterns).toBeFalsy();
    expect(byName.get(`Laatste-${tag}`)!.has_parttime_patterns).toBeTruthy();
  });

  it("counts a fellow's own blocks, not the weekend days the tick blocked", async () => {
    const fellow = (await progress()).find((r) => r.codenaam === `Aa-fellow-${tag}`)!;
    expect(fellow.is_fellow).toBeTruthy();
    expect(fellow.blocked_days_count).toBe(1);
  });

  it('downloads what the table shows, row for row', async () => {
    const [header, ...rows] = await statusReport();
    expect(header).toEqual([
      'Codenaam',
      'Status',
      'Ingediend op',
      'Geblokkeerde dagen',
      'Deeltijd',
      'Deeltijd gecontroleerd op',
      'Fellow',
    ]);
    const statusLabel: Record<string, string> = { NIET_BEGONNEN: 'Niet begonnen', BEZIG: 'Bezig', BEVESTIGD: 'Bevestigd' };
    const expected = (await progress()).map((r) => [
      r.codenaam,
      statusLabel[r.submission_status ?? 'NIET_BEGONNEN'],
      String(r.blocked_days_count),
      r.has_parttime_patterns ? 'Ja' : 'Nee',
      r.deeltijd_gecontroleerd_op ? 'ja' : '',
      r.is_fellow ? 'Ja' : 'Nee',
    ]);
    expect(rows.map((r) => [r[0], r[1], r[3], r[4], r[5] ? 'ja' : '', r[6]])).toEqual(expected);
  });

  it('answers 404 for a period that does not exist', async () => {
    const id = crypto.randomUUID();
    const res = await progressRoute(request(`/api/planner/period/${id}/progress`), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });
});
