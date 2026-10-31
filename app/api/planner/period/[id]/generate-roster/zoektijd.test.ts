import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { getRosterGenerationJob } from '@/lib/rosterGenerationJobs';
import { POST as generateRoster } from './route';

/**
 * How long the achterwacht's solver may search (0.905.0, lib/solverZoektijd.ts): a first run of CP-SAT 5 minutes
 * (on the planner's period 2 minutes left a shift empty, 5 filled them all), a chosen time up to 30 minutes as it
 * is, more refused before the solver is asked. Herhaalplanner repeats a solve up to 100 times: it keeps the solver's
 * own time per attempt, or 100 attempts of 5 minutes would be eight hours. Against a fake solver that records what
 * it is sent.
 */

const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;
let server: http.Server;
const ontvangen: Array<Record<string, unknown>> = [];
const savedSolverUrl = process.env.SOLVER_URL;

const tables = () =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`).all() as Array<{ name: string }>).map(
    (t) => t.name
  );

function insert(table: string, row: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const cols = ['id', ...Object.keys(row)];
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(id, ...Object.values(row).map((v) => v as never));
  return id;
}

/** A pool of its own with one period of five evenings and two people, under these rules. */
function periode(rules: Record<string, unknown>): string {
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Zoektijd', config_json: JSON.stringify(rules), aangemaakt_op: now });
  const pool = insert('dienstrooster_pool', { naam: `Zoektijd-${crypto.randomUUID().slice(0, 6)}`, ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: pool, naam: 'Avond', teller: 'AVOND' });
  const period = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: 'Zoektijd',
    start_datum: '2031-05-05',
    eind_datum: '2031-05-11',
    deadline: '2030-12-01T12:00:00.000Z',
    status: 'GESLOTEN',
    bevroren_ruleset_json: JSON.stringify(rules),
    aangemaakt_op: now,
  });
  for (let d = 0; d < 5; d++) {
    insert('dienstrooster_shift_slot', {
      period_id: period,
      shift_type_id: avond,
      datum: `2031-05-0${5 + d}`,
      iso_jaar: 2031,
      iso_week: 19,
      is_feestdag: 0,
      benodigd_aantal_personen: 1,
    });
  }
  for (const p of ['A', 'B']) {
    const person = insert('dienstrooster_person', { codenaam: `Zoektijd-${p}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: person, pool_id: pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
  return period;
}

function request(period: string, body: unknown): NextRequest {
  const token = createSessionToken({ kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never, STAFF_SESSION_MAX_AGE_SECONDS);
  return new NextRequest(`http://localhost/api/planner/period/${period}/generate-roster`, {
    method: 'POST',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Starts a generation and waits until it is done; what the solver was sent, per call. */
async function genereer(period: string, body?: unknown): Promise<Array<Record<string, unknown>>> {
  const voor = ontvangen.length;
  const res = await generateRoster(request(period, body), { params: Promise.resolve({ id: period }) });
  expect(res.status).toBe(200);
  const jobId = (await res.json()).data.job_id as string;
  for (let i = 0; i < 500; i++) {
    if (getRosterGenerationJob(jobId, period)?.status !== 'RUNNING') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(getRosterGenerationJob(jobId, period)?.status).toBe('DONE');
  return ontvangen.slice(voor);
}

beforeAll(async () => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  ids.planner = insert('dienstrooster_person', { codenaam: `Zoektijd-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: new Date().toISOString() });
  const basis = { windowWeeks: 0, bandAvond: [0, 9], bandWeekend: [0, 9], bandFeestdag: [0, 9] };
  ids.lexicografisch = periode({ ...basis, objectiveMode: 'lexicographic' });
  ids.gewogen = periode({ ...basis, objectiveMode: 'weighted' });
  ids.herhaal = periode({ ...basis, objectiveMode: 'multi_start', maxAttempts: 2 });

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      ontvangen.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, assignments: [], diagnostics: { unfilled_slots: [], solver_status: 'FEASIBLE', total_cost: 0, violations: {}, time_seconds: 0 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.SOLVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  process.env.SOLVER_URL = savedSolverUrl;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('how long the achterwacht solver searches (0.905.0)', () => {
  it('a first run of CP-SAT searches 5 minutes, also without a body', async () => {
    for (const period of [ids.lexicografisch, ids.gewogen]) {
      const [a] = await genereer(period);
      expect(a.time_limit_seconds).toBe(300);
      const [b] = await genereer(period, {});
      expect(b.time_limit_seconds).toBe(300);
    }
  });

  it('10 and 30 minutes go to the solver as asked; more than 30 is refused before it is asked', async () => {
    expect((await genereer(ids.lexicografisch, { time_limit_seconds: 600 }))[0].time_limit_seconds).toBe(600);
    expect((await genereer(ids.lexicografisch, { time_limit_seconds: 1800 }))[0].time_limit_seconds).toBe(1800);
    const voor = ontvangen.length;
    for (const fout of [1801, 0, 30.5, '300']) {
      const res = await generateRoster(request(ids.lexicografisch, { time_limit_seconds: fout }), { params: Promise.resolve({ id: ids.lexicografisch }) });
      expect(res.status, String(fout)).toBe(400);
      expect((await res.json()).error).toBe('Tijdslimiet moet een geheel getal tussen 1 en 1800 seconden zijn');
    }
    expect(ontvangen).toHaveLength(voor);
  });

  it('Herhaalplanner keeps the solver its own time per attempt', async () => {
    const pogingen = await genereer(ids.herhaal);
    expect(pogingen.length).toBeGreaterThan(0);
    expect(pogingen.every((p) => !('time_limit_seconds' in p))).toBe(true);
  });
});
