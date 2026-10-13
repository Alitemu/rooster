import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { getRosterGenerationJob } from '@/lib/rosterGenerationJobs';
import { getPendingUndo, setPendingUndo } from '@/lib/pendingUndo';
import { softDeletePeriod, restorePeriod } from '@/lib/periodTrash';
import { POST as autoDerive } from '@/app/api/periods/[id]/prior-assignments/auto-derive/route';
import { POST } from './route';

/**
 * What generation takes from the roster before it, taken as that roster
 * is now (audit 10).
 *
 * "Eerdere toewijzingen" carries the previous roster's last weeks into the
 * next period, so the window rule holds across the boundary - in the
 * solver and in the publication check alike. They were a snapshot: derived
 * once, and "afleiden" again skipped every day it already had. The next
 * period is open for preferences while the previous roster still runs, and
 * its last weeks change through swaps and sick leave like any other; the
 * solver then planned around who used to work those days. Rows the planner
 * set by hand stay theirs. The same goes for the previous period itself:
 * one thrown in the prullenbak is no previous period.
 *
 * And a generation is a change of its own: the "ongedaan maken" left by a
 * hand-made change before it belongs to the roster it replaced.
 *
 * P0 (published) 2030-12-23 to 2031-01-05, P1 2031-01-06 to 2031-01-19,
 * a window of two weeks, so P1 looks back one week: 2030-12-30 to
 * 2031-01-05.
 */

const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;
let server: http.Server;
let received: Array<Record<string, any>> = [];
const savedSolverUrl = process.env.SOLVER_URL;
const RULES = { windowWeeks: 2, bandAvond: [0, 9], bandWeekend: [0, 9], bandFeestdag: [0, 9] };

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

function isoWeek(datum: string): { year: number; week: number } {
  const d = new Date(`${datum}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { year: d.getUTCFullYear(), week: Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7) };
}

const addDays = (datum: string, n: number) => new Date(Date.parse(`${datum}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** A two-week period from `start`, one slot a day; `owners` hands out its days in order. */
function period(start: string, status: string, owners: string[] = []): { id: string; slots: Map<string, string> } {
  const now = new Date().toISOString();
  const id = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: `Vorig rooster ${start}`,
    start_datum: start,
    eind_datum: addDays(start, 13),
    deadline: '2030-12-01T12:00:00.000Z',
    status,
    bevroren_ruleset_json: JSON.stringify(RULES),
    aangemaakt_op: now,
    ...(status === 'GEPUBLICEERD' ? { gepubliceerd_op: now, definitief_op: now, overloop_bevestigd_op: now } : {}),
  });
  const slots = new Map<string, string>();
  for (let d = 0; d < 14; d++) {
    const datum = addDays(start, d);
    const { year, week } = isoWeek(datum);
    const weekend = d % 7 >= 5;
    const slot = insert('dienstrooster_shift_slot', {
      period_id: id,
      shift_type_id: weekend ? ids.weekend : ids.avond,
      datum,
      iso_jaar: year,
      iso_week: week,
      is_feestdag: 0,
      benodigd_aantal_personen: 1,
    });
    slots.set(datum, slot);
    if (owners[d]) {
      insert('dienstrooster_assignment', { schedule_version_id: id, person_id: ids[owners[d]], slot_id: slot, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
    }
  }
  return { id, slots };
}

function staffRequest(url: string, body: unknown = {}): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Runs generate-roster against the fake solver; the request it sent, or the refusal. */
async function generate(periodId: string): Promise<{ status: number; input?: Record<string, any>; body: any }> {
  received = [];
  const res = await POST(staffRequest(`/api/planner/period/${periodId}/generate-roster`), { params: Promise.resolve({ id: periodId }) });
  const body = await res.json();
  if (res.status !== 200) return { status: res.status, body };
  const jobId = body.data.job_id;
  for (let i = 0; i < 200; i++) {
    const job = getRosterGenerationJob(jobId, periodId);
    if (job && job.status !== 'RUNNING') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(getRosterGenerationJob(jobId, periodId)?.status).toBe('DONE');
  return { status: 200, input: received[0], body };
}

const derive = async (periodId: string) =>
  (await autoDerive(staffRequest(`/api/periods/${periodId}/prior-assignments/auto-derive`), { params: Promise.resolve({ id: periodId }) })).json();

const who = (personId: string | null) => Object.entries(ids).find(([k, v]) => v === personId && k.length === 1)?.[0] ?? personId;
const sent = (input: Record<string, any>) =>
  Object.fromEntries((input.prior_assignments as Array<{ person_id: string; datum: string }>).map((p) => [p.datum, who(p.person_id)]));

/** A pool of its own per test, so one test's published periods are never another's previous period. */
function newPool(): void {
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Vorig rooster', config_json: JSON.stringify(RULES), aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Vorig rooster', ruleset_id: ruleset, aangemaakt_op: now });
  ids.avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  ids.weekend = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Weekend', teller: 'WEEKEND' });
  for (const p of ['A', 'B', 'C', 'D']) {
    insert('dienstrooster_pool_membership', { person_id: ids[p], pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
}

beforeAll(async () => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  for (const p of ['A', 'B', 'C', 'D']) {
    ids[p] = insert('dienstrooster_person', { codenaam: `Vorig-${p}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Vorig-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });

  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push(JSON.parse(raw));
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          success: true,
          assignments: [],
          diagnostics: { unfilled_slots: [], solver_status: 'OPTIMAL', total_cost: 0, violations: {}, time_seconds: 0 },
        })
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.SOLVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  process.env.SOLVER_URL = savedSolverUrl;
  await new Promise((r) => server.close(r));
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('generation takes the previous roster as it is now', () => {
  it('follows a swap and a removal in its last weeks, and keeps what the planner set by hand', async () => {
    newPool();
    // Last week of P0 (2030-12-30 .. 2031-01-05): A B C D A B C.
    const p0 = period('2030-12-23', 'GEPUBLICEERD', ['D', 'D', 'D', 'D', 'D', 'D', 'D', 'A', 'B', 'C', 'D', 'A', 'B', 'C']);
    const p1 = period('2031-01-06', 'GESLOTEN');
    db.prepare('UPDATE dienstrooster_schedule_period SET overloop_bevestigd_op = ? WHERE id = ?').run(new Date().toISOString(), p1.id);

    const first = await derive(p1.id);
    expect(first.data.derived_count).toBe(7);

    // The planner corrected one day themselves.
    db.prepare(`UPDATE dienstrooster_prior_assignment SET person_id = ?, bron = 'HANDMATIG' WHERE period_id = ? AND datum = '2031-01-02'`).run(ids.A, p1.id);

    // Then, while P1 is open for preferences, P0's last week changes: C
    // swaps Sunday to A, Saturday's shift is taken off B, and the day the
    // planner set by hand changes in P0 too.
    const set = (datum: string, person: string) =>
      db.prepare('UPDATE dienstrooster_assignment SET person_id = ? WHERE schedule_version_id = ? AND slot_id = ?').run(ids[person], p0.id, p0.slots.get(datum));
    set('2031-01-05', 'A');
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ? AND slot_id = ?').run(p0.id, p0.slots.get('2031-01-04'));
    set('2031-01-02', 'B');

    const { input } = await generate(p1.id);
    expect(sent(input!)).toEqual({
      '2030-12-30': 'A',
      '2030-12-31': 'B',
      '2031-01-01': 'C',
      '2031-01-02': 'A', // the planner's own, not P0's B
      '2031-01-03': 'A',
      // 2031-01-04: nobody works it any more
      '2031-01-05': 'A', // after the swap, not C
    });
  });

  it('"afleiden" again updates the days it already had', async () => {
    newPool();
    const p0 = period('2031-02-03', 'GEPUBLICEERD', ['D', 'D', 'D', 'D', 'D', 'D', 'D', 'A', 'B', 'C', 'D', 'A', 'B', 'C']);
    const p1 = period('2031-02-17', 'GESLOTEN');
    await derive(p1.id);
    db.prepare('UPDATE dienstrooster_assignment SET person_id = ? WHERE schedule_version_id = ? AND slot_id = ?').run(ids.D, p0.id, p0.slots.get('2031-02-16'));
    await derive(p1.id);
    const row = db.prepare(`SELECT person_id FROM dienstrooster_prior_assignment WHERE period_id = ? AND datum = '2031-02-16'`).get(p1.id) as { person_id: string };
    expect(who(row.person_id)).toBe('D');
  });
});

describe('a previous period in the prullenbak', () => {
  it('needs no overloop confirmation and gives no earlier shifts', async () => {
    newPool();
    const p0 = period('2031-03-03', 'GEPUBLICEERD', ['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D', 'A', 'B', 'C', 'D', 'A', 'B']);
    const p1 = period('2031-03-17', 'GESLOTEN');
    softDeletePeriod(p0.id, ids.planner);

    expect((await derive(p1.id)).data.derived_count).toBe(0);
    const { status, input, body } = await generate(p1.id);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(input!.prior_assignments).toEqual([]);

    // Restored, it is the previous period again - and asks for confirmation.
    restorePeriod(p0.id, ids.planner);
    expect((await generate(p1.id)).status).toBe(400);
  });
});

describe('a generation replaces the roster the last "ongedaan maken" belonged to', () => {
  it('clears it', async () => {
    newPool();
    const p1 = period('2031-04-07', 'GESLOTEN');
    db.transaction(() =>
      setPendingUndo({
        scope: 'PERIOD_ASSIGNMENT',
        scopeId: p1.id,
        actionType: 'REMOVE',
        payload: { slot_id: p1.slots.get('2031-04-07'), person_id: ids.A, bron: 'SOLVER' },
        label: 'verwijderd',
        actorId: ids.planner,
      })
    )();
    expect((await generate(p1.id)).status).toBe(200);
    expect(getPendingUndo(p1.id)).toBeUndefined();
  });
});
