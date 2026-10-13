import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { getRosterGenerationJob } from '@/lib/rosterGenerationJobs';
import { POST as resetRoster } from './route';
import { POST as generate } from '../../../planner/period/[id]/generate-roster/route';

/**
 * "Rooster verwijderen" next to the rest of a period's life (audit 9):
 *
 * while a regeneration runs it is refused, and the regeneration's own
 * roster is what is left afterwards - never a reset half-overwritten.
 *
 * Swap requests play no part: a roster is only removed before it is
 * published, and swaps only exist on a published one. (A roster published
 * by mistake and withdrawn at once has none either - the planner's call
 * after audit 9.)
 */

const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;
let server: http.Server;
let release: () => void = () => {};
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

const cookie = () =>
  `${SESSION_COOKIE_NAME}=${createSessionToken({ kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never, STAFF_SESSION_MAX_AGE_SECONDS)}`;

function call(handler: unknown, url: string, periodId: string, body: unknown = {}) {
  return (handler as (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>)(
    new NextRequest(`http://localhost${url}`, {
      method: 'POST',
      headers: { Cookie: cookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: periodId }) }
  );
}

/** A period with two weekday avonddiensten, A and B each holding one. */
function period(status: string): { id: string; slots: string[] } {
  const now = new Date().toISOString();
  const rules = { windowWeeks: 0, bandAvond: [0, 2], bandWeekend: [0, 0], bandFeestdag: [0, 0] };
  const id = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: `Levensloop ${status} ${crypto.randomUUID().slice(0, 4)}`,
    start_datum: '2031-05-05',
    eind_datum: '2031-05-11',
    deadline: '2031-01-01T12:00:00.000Z',
    status,
    bevroren_ruleset_json: JSON.stringify(rules),
    aangemaakt_op: now,
    ...(status === 'GEPUBLICEERD' ? { gepubliceerd_op: now, definitief_op: now } : {}),
  });
  const slots = ['2031-05-05', '2031-05-06'].map((datum) =>
    insert('dienstrooster_shift_slot', { period_id: id, shift_type_id: ids.avond, datum, iso_jaar: 2031, iso_week: 19, is_feestdag: 0, benodigd_aantal_personen: 1 })
  );
  insert('dienstrooster_assignment', { schedule_version_id: id, person_id: ids.A, slot_id: slots[0], bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  insert('dienstrooster_assignment', { schedule_version_id: id, person_id: ids.B, slot_id: slots[1], bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  return { id, slots };
}

beforeAll(async () => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Levensloop', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Levensloop', ruleset_id: ruleset, aangemaakt_op: now });
  ids.avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  for (const who of ['A', 'B']) {
    ids[who] = insert('dienstrooster_person', { codenaam: `Levensloop-${who}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: ids[who], pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Levensloop-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });

  // A solver that holds its answer until the test lets go, then fills
  // every slot with A.
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const slots = JSON.parse(raw).slots as Array<{ id: string }>;
      release = () =>
        res.end(
          JSON.stringify({
            success: true,
            assignments: slots.map((s) => ({ slot_id: s.id, person_id: ids.A })),
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
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('Rooster verwijderen in the life of a period', () => {
  it('is refused while a regeneration runs, which then leaves its own roster', async () => {
    const p = period('GEGENEREERD');
    const started = await call(generate, `/api/planner/period/${p.id}/generate-roster`, p.id);
    const jobId = ((await started.json()) as { data: { job_id: string } }).data.job_id;
    // Wait until the request has reached the solver.
    for (let i = 0; i < 100 && !getRosterGenerationJob(jobId, p.id); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));

    const refused = await call(resetRoster, `/api/periods/${p.id}/reset-roster`, p.id, { ook_handmatig: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('GENERATION_RUNNING');

    release();
    let job = getRosterGenerationJob(jobId, p.id);
    for (let i = 0; i < 200 && job?.status === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 25));
      job = getRosterGenerationJob(jobId, p.id);
    }
    expect(job?.status).toBe('DONE');
    const rows = db.prepare('SELECT person_id FROM dienstrooster_assignment WHERE schedule_version_id = ?').all(p.id) as Array<{ person_id: string }>;
    expect(rows.map((r) => r.person_id)).toEqual([ids.A, ids.A]);

    // Afterwards it goes through.
    expect((await call(resetRoster, `/api/periods/${p.id}/reset-roster`, p.id, {})).status).toBe(200);
  });
});
