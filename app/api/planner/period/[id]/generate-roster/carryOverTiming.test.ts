import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { getRosterGenerationJob } from '@/lib/rosterGenerationJobs';
import { applyCarryOverForPeriod } from '@/lib/carryOver';
import { POST as generate } from './route';
import { POST as reassign } from '../assignments/[assignment-id]/reassign/route';

/**
 * The rule: what someone did in one period counts for their streefbereik
 * in the next, also when the period was corrected after the next one
 * opened.
 *
 * The next period opens for preferences while the current roster still
 * runs, and that roster keeps being corrected: someone falls ill, the
 * planner gives the shift to a colleague. Carry-over is worked out when
 * the next period opens (lib/carryOver.ts, called from the open route
 * only). A correction made after that never reaches the ledger - not for
 * the next period, and not later, since each period only looks at the one
 * before it.
 *
 * Two people with a fixed band of exactly two avonddiensten each; after
 * the next period opened, one of A's two is given to B. Generating the
 * next period should then hold A to one more and B to one fewer.
 */

const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;
let server: http.Server;
let received: Array<Record<string, any>> = [];
const savedSolverUrl = process.env.SOLVER_URL;
const RULES = { windowWeeks: 0, bandAvond: [2, 2], bandWeekend: [0, 0], bandFeestdag: [0, 0] };

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

function cookie(): string {
  const token = createSessionToken({ kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never, STAFF_SESSION_MAX_AGE_SECONDS);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/** A period of two weeks with an avonddienst every weekday (10 slots). */
function period(start: string, status: string): { id: string; slots: string[] } {
  const now = new Date().toISOString();
  const id = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: `Overloop ${start}`,
    start_datum: start,
    eind_datum: new Date(Date.parse(`${start}T00:00:00Z`) + 13 * 86400000).toISOString().slice(0, 10),
    deadline: '2030-12-01T12:00:00.000Z',
    status,
    bevroren_ruleset_json: JSON.stringify(RULES),
    aangemaakt_op: now,
    ...(status === 'GEPUBLICEERD' ? { gepubliceerd_op: now, definitief_op: now } : { overloop_bevestigd_op: now }),
  });
  const slots: string[] = [];
  for (let d = 0; d < 14; d++) {
    if (d % 7 >= 5) continue;
    const datum = new Date(Date.parse(`${start}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
    slots.push(
      insert('dienstrooster_shift_slot', { period_id: id, shift_type_id: ids.avond, datum, iso_jaar: 2031, iso_week: 2 + Math.floor(d / 7), is_feestdag: 0, benodigd_aantal_personen: 1 })
    );
  }
  return { id, slots };
}

beforeAll(async () => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Overloop', config_json: JSON.stringify(RULES), aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Overloop', ruleset_id: ruleset, aangemaakt_op: now });
  ids.avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  for (const who of ['A', 'B', 'C', 'D', 'E']) {
    ids[who] = insert('dienstrooster_person', { codenaam: `Overloop-${who}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: ids[who], pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Overloop-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });

  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push(JSON.parse(raw));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, assignments: [], diagnostics: { unfilled_slots: [], solver_status: 'OPTIMAL', total_cost: 0, violations: {}, time_seconds: 0 } }));
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

async function generatedBalances(periodId: string): Promise<Record<string, Record<string, number>>> {
  received = [];
  const res = await generate(
    new NextRequest(`http://localhost/api/planner/period/${periodId}/generate-roster`, {
      method: 'POST',
      headers: { Cookie: cookie(), 'Content-Type': 'application/json' },
      body: '{}',
    }),
    { params: Promise.resolve({ id: periodId }) }
  );
  const body = (await res.json()) as { data?: { job_id: string } };
  expect(res.status, JSON.stringify(body)).toBe(200);
  for (let i = 0; i < 200 && getRosterGenerationJob(body.data!.job_id, periodId)?.status === 'RUNNING'; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(received).toHaveLength(1);
  return received[0].balances;
}

describe('carry-over follows corrections made after the next period opened', () => {
  // Audit 8: the next period keeps the carry-over worked out when it
  // opened; A and B are both still at zero.
  it.fails('a shift moved from A to B in the running roster reaches the next period', async () => {
    const current = period('2031-01-06', 'GEPUBLICEERD');
    // Everyone exactly at their band of two: nothing carries.
    const owners = ['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'E', 'E'];
    const aShift = current.slots.map((slot, i) =>
      insert('dienstrooster_assignment', { schedule_version_id: current.id, person_id: ids[owners[i]], slot_id: slot, bron: 'SOLVER', row_version: 1, aangemaakt_op: new Date().toISOString() })
    )[0];
    const next = period('2031-01-20', 'GESLOTEN');
    expect(applyCarryOverForPeriod(next.id, ids.planner)).toBe(0);

    // A falls ill; the planner gives one of A's shifts to B.
    const moved = await reassign(
      new NextRequest(`http://localhost/api/planner/period/${current.id}/assignments/${aShift}/reassign`, {
        method: 'POST',
        headers: { Cookie: cookie(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ person_id: ids.B, reason: 'Ziek' }),
      }),
      { params: Promise.resolve({ id: current.id, 'assignment-id': aShift }) }
    );
    expect(moved.status, await moved.clone().text()).toBeLessThan(300);

    const balances = await generatedBalances(next.id);
    expect({ A: balances[ids.A].AVOND, B: balances[ids.B].AVOND }).toEqual({ A: 1, B: -1 });
  });
});
