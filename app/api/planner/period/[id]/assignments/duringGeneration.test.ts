import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { getRosterGenerationJob } from '@/lib/rosterGenerationJobs';
import { setPendingUndo } from '@/lib/pendingUndo';
import { POST as generateRoster } from '../generate-roster/route';
import { POST as manualAssign } from './manual-assign/route';
import { POST as reassign } from './[assignment-id]/reassign/route';
import { DELETE as remove } from './[assignment-id]/delete/route';
import { POST as undoLast } from './undo-last/route';

/**
 * The rule: while a generation runs, nobody changes the roster under it
 * (audit 10).
 *
 * A generation reads the hand-made shifts when it starts and writes the
 * solver's roster when the solver answers, minutes later. A shift filled by
 * hand in between - a second planner, a second tab - was unknown to the
 * solver: on a day it filled too the whole result died on the assignment
 * table's UNIQUE constraint and the planner saw an internal error after
 * waiting for it; on another day the solver could give the same person a
 * second shift that week, a window-rule break nobody chose. "Rooster
 * verwijderen" already refused while a generation ran; manual-assign,
 * reassign, delete and undo now do too.
 */

const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;
let server: http.Server;
let release: (() => void) | null = null;
let answer: Array<{ person_id: string; slot_id: string }> = [];
const savedSolverUrl = process.env.SOLVER_URL;

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

function request(url: string, method: string, body: unknown = {}): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const rules = { windowWeeks: 0, bandAvond: [0, 9], bandWeekend: [0, 9], bandFeestdag: [0, 9] };
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Tijdens genereren', config_json: JSON.stringify(rules), aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Tijdens genereren', ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: 'Tijdens genereren',
    start_datum: '2031-05-05',
    eind_datum: '2031-05-11',
    deadline: '2030-12-01T12:00:00.000Z',
    status: 'GEGENEREERD',
    bevroren_ruleset_json: JSON.stringify(rules),
    aangemaakt_op: now,
  });
  for (let d = 0; d < 5; d++) {
    ids[`slot${d}`] = insert('dienstrooster_shift_slot', {
      period_id: ids.period,
      shift_type_id: avond,
      datum: `2031-05-0${5 + d}`,
      iso_jaar: 2031,
      iso_week: 19,
      is_feestdag: 0,
      benodigd_aantal_personen: 1,
    });
  }
  for (const p of ['A', 'B', 'C']) {
    ids[p] = insert('dienstrooster_person', { codenaam: `Tijdens-${p}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: ids[p], pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Tijdens-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
  // A manual shift from before the generation: the one reassign and delete act on.
  ids.manual = insert('dienstrooster_assignment', { schedule_version_id: ids.period, person_id: ids.A, slot_id: ids.slot0, bron: 'MANUAL', row_version: 1, aangemaakt_op: now });

  // A solver that answers only when the test lets it.
  server = http.createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      release = () => {
        release = null;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            success: true,
            assignments: answer,
            diagnostics: { unfilled_slots: [], solver_status: 'OPTIMAL', total_cost: 0, violations: {}, time_seconds: 0 },
          })
        );
      };
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.SOLVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  release?.();
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

describe('the roster stays as it is while a generation runs', () => {
  it('refuses hand-made changes until the solver has answered, and then the result lands', async () => {
    answer = [{ person_id: ids.B, slot_id: ids.slot1 }];
    const started = await generateRoster(request(`/api/planner/period/${ids.period}/generate-roster`, 'POST'), {
      params: Promise.resolve({ id: ids.period }),
    });
    expect(started.status).toBe(200);
    const jobId = (await started.json()).data.job_id as string;
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    expect(release, 'the solver was called').not.toBeNull();

    const period = { params: Promise.resolve({ id: ids.period }) };
    const onAssignment = { params: Promise.resolve({ id: ids.period, 'assignment-id': ids.manual }) };
    // The day the solver is about to fill: this one used to kill the result.
    const assign = await manualAssign(
      request(`/api/planner/period/${ids.period}/assignments/manual-assign`, 'POST', { person_id: ids.C, slot_id: ids.slot1 }),
      period
    );
    expect(assign.status).toBe(409);
    const moved = await reassign(
      request(`/api/planner/period/${ids.period}/assignments/${ids.manual}/reassign`, 'POST', { person_id: ids.C }),
      onAssignment
    );
    expect(moved.status).toBe(409);
    const removed = await remove(request(`/api/planner/period/${ids.period}/assignments/${ids.manual}/delete`, 'DELETE'), onAssignment);
    expect(removed.status).toBe(409);
    db.transaction(() =>
      setPendingUndo({
        scope: 'PERIOD_ASSIGNMENT',
        scopeId: ids.period,
        actionType: 'ASSIGN',
        payload: { assignment_id: ids.manual, person_id: ids.A, slot_id: ids.slot0 },
        label: 'toegewezen',
        actorId: ids.planner,
      })
    )();
    const undone = await undoLast(request(`/api/planner/period/${ids.period}/assignments/undo-last`, 'POST'), period);
    expect(undone.status).toBe(409);
    expect(JSON.stringify(await undone.json())).toMatch(/roostergeneratie/);

    release!();
    for (let i = 0; i < 200; i++) {
      if (getRosterGenerationJob(jobId, ids.period)?.status !== 'RUNNING') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(getRosterGenerationJob(jobId, ids.period)?.status).toBe('DONE');
    const roster = db
      .prepare('SELECT person_id, slot_id, bron FROM dienstrooster_assignment WHERE schedule_version_id = ? ORDER BY bron')
      .all(ids.period);
    expect(roster).toEqual([
      { person_id: ids.A, slot_id: ids.slot0, bron: 'MANUAL' },
      { person_id: ids.B, slot_id: ids.slot1, bron: 'SOLVER' },
    ]);
  });
});
