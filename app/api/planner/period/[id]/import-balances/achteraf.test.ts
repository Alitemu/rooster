import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { getRosterGenerationJob } from '@/lib/rosterGenerationJobs';
import { computeMemberTargets } from '@/lib/rosterBands';
import { CORRECTION_REASONS_BY_TOP_LEVEL, correctieRegels } from '@/lib/correctieRedenen';
import { POST as importBalances } from './route';
import { GET as listCorrections, POST as addCorrections } from '../ledger-corrections/route';
import { POST as generateRoster } from '../generate-roster/route';

/**
 * The rule (1.1.0): a beginsaldo imported or a correctie entered after the
 * period has opened - the section "Import en correcties" on the period page,
 * the invitations already out - counts for the roster exactly like one made
 * in the wizard: generate-roster tells the solver each person's shifted
 * band, and that is the band the app checks the roster against.
 *
 * A fake solver on a local port records the request generate-roster really
 * sends (as solverContract.test.ts does). That the real solver then gives
 * each person that many shifts is tests/e2e/import-correcties.e2e.ts, with
 * the real solver.
 */

const START = '2032-01-05'; // Monday
const END = '2032-02-29'; // Sunday, 8 weeks
const ids: Record<string, string> = {};
const codenaam: Record<string, string> = {};
let rowidsBefore: Map<string, number>;
let server: http.Server;
let received: Array<Record<string, any>> = [];
let hold: Promise<void> | null = null;
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

function request(path: string, method: string, body?: unknown): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = () => ({ params: Promise.resolve({ id: ids.period }) });

function ledgerCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ?').get(ids.period) as { n: number }).n;
}

function setStatus(status: string): void {
  db.prepare('UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?').run(status, ids.period);
}

/** Starts generate-roster against the fake solver; resolves with the job id. */
async function startGeneration(): Promise<string> {
  const res = await generateRoster(request(`/api/planner/period/${ids.period}/generate-roster`, 'POST', {}), params());
  const body = (await res.json()) as { data?: { job_id: string } };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.data!.job_id;
}

async function waitForJob(jobId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const job = getRosterGenerationJob(jobId, ids.period);
    if (job && job.status !== 'RUNNING') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('generation did not finish');
}

/** A person's band for one counter as the solver reads its input (solver/constraints.py add_band_constraints). */
function solverBand(input: Record<string, any>, personId: string, teller: 'AVOND' | 'WEEKEND'): [number, number] {
  const range: [number, number] = teller === 'AVOND' ? input.rules.band_avond : input.rules.band_weekend;
  const override = input.band_overrides?.[personId]?.[teller];
  if (override) return [override[0], override[1]];
  const delta = input.balances?.[personId]?.[teller] ?? 0;
  return [Math.max(0, range[0] + delta), Math.max(0, range[1] + delta)];
}

beforeAll(async () => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      received.push(JSON.parse(raw));
      if (hold) await hold;
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

  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Achteraf', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Achteraf', ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  // The invitations are out: the period is open, frozen ruleset and all.
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: 'Achteraf',
    start_datum: START,
    eind_datum: END,
    deadline: '2031-12-15T12:00:00.000Z',
    status: 'OPEN',
    bevroren_ruleset_json: JSON.stringify({ windowWeeks: 0, bandAvond: [2, 2], bandWeekend: [0, 1], bandFeestdag: [0, 0] }),
    overloop_bevestigd_op: now,
    uitgenodigd_op: now,
    aangemaakt_op: now,
  });
  // One avonddienst on each Monday: eight.
  for (let week = 0; week < 8; week++) {
    const d = new Date(Date.UTC(2032, 0, 5 + week * 7));
    insert('dienstrooster_shift_slot', {
      period_id: ids.period,
      shift_type_id: avond,
      datum: d.toISOString().slice(0, 10),
      iso_jaar: 2032,
      iso_week: week + 2,
      is_feestdag: 0,
      benodigd_aantal_personen: 1,
    });
  }
  for (const label of ['import', 'correctie', 'ruil', 'niets']) {
    codenaam[label] = `Achteraf-${label}-${crypto.randomUUID().slice(0, 6)}`;
    ids[label] = insert('dienstrooster_person', { codenaam: codenaam[label], rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: ids[label], pool_id: ids.pool, geldig_vanaf: '2020-01-01', geldig_tot: '2099-12-31' });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Achteraf-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
});

afterAll(async () => {
  process.env.SOLVER_URL = savedSolverUrl;
  await new Promise((r) => server.close(r));
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) {
      db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('a beginsaldo or correctie added after the opening', () => {
  it('reaches the solver as each person\'s own band, the one the app checks the roster against', async () => {
    // The Excel file: one avonddienst extra for one person.
    const imp = await importBalances(
      request(`/api/planner/period/${ids.period}/import-balances`, 'POST', {
        rows: [{ codenaam: codenaam.import, AVOND_delta: 1, WEEKEND_delta: 0 }],
      }),
      params()
    );
    expect(imp.status).toBe(200);
    expect((await imp.json()).data).toMatchObject({ personen: 1, errors: [] });

    // A correctie as the section's form sends it: one avonddienst fewer, and an ongelijke ruil
    // (one avonddienst more, one weekenddienst fewer) in its two halves.
    const overig = CORRECTION_REASONS_BY_TOP_LEVEL.AVOND.find((r) => r.label === 'Overig')!;
    const ruil = CORRECTION_REASONS_BY_TOP_LEVEL.RUIL.find((r) => r.type === 'RUIL_AVOND_VOOR_WEEKEND')!;
    for (const [persoon, regels] of [
      [ids.correctie, correctieRegels(overig, -1)],
      [ids.ruil, correctieRegels(ruil, 1)],
    ] as const) {
      const res = await addCorrections(
        request(`/api/planner/period/${ids.period}/ledger-corrections`, 'POST', {
          corrections: regels.map((r) => ({ person_id: persoon, ...r })),
        }),
        params()
      );
      expect(res.status).toBe(200);
    }

    setStatus('GESLOTEN');
    received = [];
    await waitForJob(await startGeneration());
    expect(received).toHaveLength(1);
    const input = received[0];

    const verwacht: Record<string, { AVOND: [number, number]; WEEKEND: [number, number] }> = {
      import: { AVOND: [3, 3], WEEKEND: [0, 1] },
      correctie: { AVOND: [1, 1], WEEKEND: [0, 1] },
      ruil: { AVOND: [3, 3], WEEKEND: [0, 0] },
      niets: { AVOND: [2, 2], WEEKEND: [0, 1] },
    };
    const targets = computeMemberTargets(ids.period);
    for (const [label, banden] of Object.entries(verwacht)) {
      for (const teller of ['AVOND', 'WEEKEND'] as const) {
        expect({ label, teller, band: solverBand(input, ids[label], teller) }).toEqual({ label, teller, band: banden[teller] });
        const checked = targets.get(ids[label])![teller];
        expect({ label, teller, band: [checked.min, checked.max] }).toEqual({ label, teller, band: banden[teller] });
      }
    }
  });

  it('is refused while a generation of the period runs, and nothing is written', async () => {
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(ids.period);
    setStatus('GESLOTEN');
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const jobId = await startGeneration();
    try {
      for (let i = 0; i < 200 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      const before = ledgerCount();
      const imp = await importBalances(
        request(`/api/planner/period/${ids.period}/import-balances`, 'POST', {
          rows: [{ codenaam: codenaam.niets, AVOND_delta: 2, WEEKEND_delta: 0 }],
        }),
        params()
      );
      expect(imp.status).toBe(409);
      expect((await imp.json()).error.code).toBe('GENERATIE_LOOPT');
      const corr = await addCorrections(
        request(`/api/planner/period/${ids.period}/ledger-corrections`, 'POST', {
          corrections: [{ person_id: ids.niets, type: 'AVOND', reden: 'Overig', aantal: 1 }],
        }),
        params()
      );
      expect(corr.status).toBe(409);
      expect((await corr.json()).error.code).toBe('GENERATIE_LOOPT');
      expect(ledgerCount()).toBe(before);
    } finally {
      release();
      hold = null;
      received = [];
      await waitForJob(jobId);
    }
  });

  it('is refused once the roster is generated', async () => {
    setStatus('GEGENEREERD');
    const before = ledgerCount();
    const imp = await importBalances(
      request(`/api/planner/period/${ids.period}/import-balances`, 'POST', {
        rows: [{ codenaam: codenaam.niets, AVOND_delta: 2, WEEKEND_delta: 0 }],
      }),
      params()
    );
    expect(imp.status).toBe(400);
    const corr = await addCorrections(
      request(`/api/planner/period/${ids.period}/ledger-corrections`, 'POST', {
        corrections: [{ person_id: ids.niets, type: 'AVOND', reden: 'Overig', aantal: 1 }],
      }),
      params()
    );
    expect(corr.status).toBe(400);
    expect(ledgerCount()).toBe(before);
  });

  it('lists the correcties of this period only, in words the section can show', async () => {
    const now = new Date().toISOString();
    const other = insert('dienstrooster_schedule_period', {
      pool_id: ids.pool,
      naam: 'Achteraf ander',
      start_datum: '2032-03-01',
      eind_datum: '2032-03-28',
      deadline: '2032-02-15T12:00:00.000Z',
      status: 'OPEN',
      aangemaakt_op: now,
    });
    insert('dienstrooster_ledger_entry', {
      person_id: ids.niets,
      pool_id: ids.pool,
      teller: 'AVOND',
      geldt_voor_periode_id: other,
      delta: 5,
      reden: 'Andere periode',
      categorie: 'CORRECTIE',
      aangemaakt_door: ids.planner,
      aangemaakt_op: now,
    });
    const res = await listCorrections(request(`/api/planner/period/${ids.period}/ledger-corrections`, 'GET'), params());
    expect(res.status).toBe(200);
    const { correcties } = (await res.json()).data as { correcties: Array<{ codenaam: string; teller: string; delta: number; reden: string }> };
    // The three rows of the first test, no beginsaldo, nothing of the other period.
    expect(correcties.map(({ codenaam: c, teller, delta, reden }) => ({ c, teller, delta, reden }))).toEqual([
      { c: codenaam.correctie, teller: 'AVOND', delta: -1, reden: 'Overig' },
      { c: codenaam.ruil, teller: 'AVOND', delta: 1, reden: 'Ruil avond- voor weekenddienst' },
      { c: codenaam.ruil, teller: 'WEEKEND', delta: -1, reden: 'Ruil weekend- voor avonddienst' },
    ]);
  });
});
