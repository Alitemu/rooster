import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { getRosterGenerationJob } from '@/lib/rosterGenerationJobs';
import { computeMemberTargets, resolveWindowWeeks } from '@/lib/rosterBands';
import { feestdagTargets } from '@/lib/feestdagHistory';
import { halveDeelname } from '@/tests/fixtures/deeltijd';
import { POST } from './route';

/**
 * The contract between the app and the solver: the streefbereik the solver
 * is told to respect is the one the app later judges the roster by.
 *
 * computeMemberTargets (publication check, band room in pick lists, "Jouw
 * rooster") and generate-roster's solver input are built by two pieces of
 * code. If they drift, the solver builds a roster to one target and the
 * publication check warns about another - or a participant is shown a
 * range the solver never aimed for.
 *
 * A fake solver on a local port records the request generate-roster really
 * sends. The test then works out each person's band from that request the
 * way solver/constraints.py add_band_constraints does, and compares.
 */

type Teller = 'AVOND' | 'WEEKEND' | 'FEESTDAG';
const TELLERS: Teller[] = ['AVOND', 'WEEKEND', 'FEESTDAG'];

const START = '2031-01-06'; // Monday
const END = '2031-03-02'; // Sunday, 8 weeks
const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;
let server: http.Server;
let received: Array<Record<string, any>> = [];
const savedSolverUrl = process.env.SOLVER_URL;

function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

function maxRowids(): Map<string, number> {
  return new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
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

/** A pool, a period with avond- and weekend slots, and the people the cases below need. */
function buildPeriod(distributionMode: string, rules: Record<string, unknown> = { windowWeeks: 0 }): void {
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Contract', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: `Contract-${distributionMode}`, ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  const weekend = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Weekend', teller: 'WEEKEND' });
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: `Contract-${distributionMode}`,
    start_datum: START,
    eind_datum: END,
    deadline: '2030-12-01T12:00:00.000Z',
    status: 'GESLOTEN',
    bevroren_ruleset_json: JSON.stringify({ ...rules, distributionMode }),
    aangemaakt_op: now,
  });
  const slotIds: string[] = [];
  for (let day = 0; day < 56; day++) {
    const d = new Date(Date.UTC(2031, 0, 6 + day));
    const datum = d.toISOString().slice(0, 10);
    const { year, week } = isoWeek(datum);
    const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    slotIds.push(
      insert('dienstrooster_shift_slot', {
        period_id: ids.period,
        shift_type_id: isWeekend ? weekend : avond,
        datum,
        iso_jaar: year,
        iso_week: week,
        is_feestdag: 0,
        benodigd_aantal_personen: 1,
      })
    );
  }

  const person = (label: string) =>
    insert('dienstrooster_person', { codenaam: `Contract-${label}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  const member = (personId: string, vanaf: string, tot: string, factor = 1) =>
    insert('dienstrooster_pool_membership', { person_id: personId, pool_id: ids.pool, deelnamefactor: factor, geldig_vanaf: vanaf, geldig_tot: tot });

  for (let i = 0; i < 8; i++) member(person(`vast${i}`), '2020-01-01', '2099-12-31');
  // Joins halfway: a single membership that covers half the period.
  ids.halfway = person('halverwege');
  member(ids.halfway, '2031-02-03', '2099-12-31');
  // Part-time: counts for less only under NAAR_RATO. The factor is the person's own, from their part-time
  // days (lib/deelnamefactor.ts), not a column of the membership: two days off every week and one every
  // other week is 0,5.
  ids.parttime = person('deeltijd');
  member(ids.parttime, '2020-01-01', '2099-12-31');
  halveDeelname(ids.parttime);
  // Present the whole period, but the planner changed their factor after
  // two weeks by ending one membership and starting the next.
  ids.split = person('gesplitst');
  member(ids.split, '2020-01-01', '2031-01-19', 1);
  member(ids.split, '2031-01-20', '2099-12-31', 1);
  // A correction from the ledger: one avonddienst fewer.
  ids.ledger = person('saldo');
  member(ids.ledger, '2020-01-01', '2099-12-31');
  ids.planner = insert('dienstrooster_person', { codenaam: `Contract-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
  insert('dienstrooster_ledger_entry', {
    person_id: ids.ledger,
    pool_id: ids.pool,
    teller: 'AVOND',
    geldt_voor_periode_id: ids.period,
    delta: -1,
    reden: 'Contracttest',
    categorie: 'CORRECTIE',
    aangemaakt_door: ids.planner,
    aangemaakt_op: now,
  });
  // A fellow: no weekends of their own, the others' weekend band goes up.
  ids.fellow = person('fellow');
  member(ids.fellow, '2020-01-01', '2099-12-31');
  insert('dienstrooster_period_fellow', { period_id: ids.period, person_id: ids.fellow, aangemaakt_op: now });
  // A shift filled in by hand: the solver gets the rest of the band.
  insert('dienstrooster_assignment', {
    schedule_version_id: ids.period,
    person_id: ids.ledger,
    slot_id: slotIds[0],
    bron: 'MANUAL',
    row_version: 1,
    aangemaakt_op: now,
  });
}

/** Runs generate-roster against the fake solver and returns the request it sent. */
async function generate(): Promise<Record<string, any>> {
  received = [];
  const token = createSessionToken(
    { kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  const res = await POST(
    new NextRequest(`http://localhost/api/planner/period/${ids.period}/generate-roster`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    }),
    { params: Promise.resolve({ id: ids.period }) }
  );
  const body = (await res.json()) as { success: boolean; data?: { job_id: string }; error?: unknown };
  expect(res.status, JSON.stringify(body)).toBe(200);
  const jobId = body.data!.job_id;
  for (let i = 0; i < 200; i++) {
    const job = getRosterGenerationJob(jobId, ids.period);
    if (job && job.status !== 'RUNNING') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(received).toHaveLength(1);
  return received[0];
}

/** A person's total band for one counter, read from the solver's input the way constraints.py applies it. */
function solverBand(input: Record<string, any>, personId: string, teller: Teller): [number, number] {
  const rules = input.rules;
  const ranges: Record<Teller, [number, number]> = { AVOND: rules.band_avond, WEEKEND: rules.band_weekend, FEESTDAG: rules.band_feestdag };
  const override = input.band_overrides?.[personId]?.[teller];
  if (override) return [override[0], override[1]];
  let [min, max] = ranges[teller];
  const coverage = input.coverage_factors?.[personId] ?? 1;
  min = Math.floor(min * coverage);
  max = Math.max(min, Math.ceil(max * coverage));
  if (rules.distribution_mode === 'NAAR_RATO') {
    const f = input.participation_factors?.[personId] ?? 1;
    min = Math.floor(min * f);
    max = Math.max(min, Math.ceil(max * f));
  }
  const delta = input.balances?.[personId]?.[teller] ?? 0;
  // The solver subtracts shifts filled in by hand from what it still has to
  // give; the total it aims for is this.
  return [min + delta, max + delta];
}

beforeAll(async () => {
  rowidsBefore = maxRowids();
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
    for (const table of tables()) {
      db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe.each(['GELIJK', 'NAAR_RATO'])('the solver is told the streefbereik the app checks against (%s)', (mode) => {
  it('every person, every counter', async () => {
    buildPeriod(mode);
    const input = await generate();
    const targets = computeMemberTargets(ids.period);

    expect(new Set(input.people)).toEqual(new Set(targets.keys()));
    for (const personId of input.people as string[]) {
      for (const teller of TELLERS) {
        const told = solverBand(input, personId, teller);
        const checked = targets.get(personId)![teller];
        expect({ personId, teller, band: [checked.min, checked.max] }).toEqual({ personId, teller, band: told });
      }
    }
    // Feestdagdiensten over the years (lib/feestdagHistory.ts): one target
    // per person the solver plans, the same numbers the app works out.
    expect(Object.keys(input.feestdag_targets).sort()).toEqual([...(input.people as string[])].sort());
    expect(input.feestdag_targets).toEqual(feestdagTargets(ids.period));
    // The shift filled in by hand went as a fact, not as a slot to fill.
    expect(input.manual_assignments).toEqual([expect.objectContaining({ person_id: ids.ledger, teller: 'AVOND' })]);
    expect(input.slots).toHaveLength(55);
  });

  // The solver is sent the factor from the part-time days, whatever the mode: under GELIJK it ignores it,
  // under NAAR_RATO it narrows the part-timer's band. Both sides above use one loader, so the factor itself
  // is held here.
  it('the part-timer is sent with their factor from the part-time days, everyone else with 1', async () => {
    buildPeriod(mode);
    const input = await generate();
    expect(input.participation_factors[ids.parttime]).toBe(0.5);
    for (const personId of input.people as string[]) {
      if (personId !== ids.parttime) expect(input.participation_factors[personId] ?? 1).toBe(1);
    }
    if (mode === 'NAAR_RATO') {
      const full = input.people.find((p: string) => ![ids.split, ids.halfway, ids.parttime, ids.ledger, ids.fellow].includes(p));
      let smaller = 0;
      for (const teller of TELLERS) {
        const [minVol, maxVol] = solverBand(input, full, teller);
        const [minDeel, maxDeel] = solverBand(input, ids.parttime, teller);
        expect(maxDeel).toBeLessThanOrEqual(maxVol);
        expect(minDeel).toBeLessThanOrEqual(minVol);
        if (maxDeel < maxVol) smaller++;
      }
      // At least the counter with real numbers in it: the part-timer's band is narrower than a full-timer's.
      expect(smaller).toBeGreaterThan(0);
    }
  });

  // Audit 7: a person with two memberships in one period (they stopped and
  // came back) used to count with one of them only: generate-roster kept
  // the last row per person, computeMemberTargets overwrote with it, and
  // someone present the whole period got the streefbereik of three
  // quarters of it. Both now count all of them (loadPeriodMembers).
  it('someone present the whole period over two memberships gets a full member’s target', async () => {
    buildPeriod(mode);
    const input = await generate();
    const full = input.people.find((p: string) => ![ids.split, ids.halfway, ids.parttime, ids.ledger, ids.fellow].includes(p));
    for (const teller of TELLERS) {
      expect(solverBand(input, ids.split, teller)).toEqual(solverBand(input, full, teller));
      expect(computeMemberTargets(ids.period).get(ids.split)![teller]).toEqual(computeMemberTargets(ids.period).get(full)![teller]);
    }
  });
});

/** The windows the solver applies, read from its input the way solver.py build_model does. */
function solverWindows(rules: Record<string, any>): { avond: number; weekendFeestdag: number } {
  const perTeller = rules.window_weeks_avond !== undefined || rules.window_weeks_weekend_feestdag !== undefined;
  if (!perTeller) return { avond: rules.window_weeks, weekendFeestdag: rules.window_weeks };
  return { avond: rules.window_weeks_avond ?? 0, weekendFeestdag: rules.window_weeks_weekend_feestdag ?? 0 };
}

describe('the solver is told the windows the app checks against', () => {
  // lib/windowRule.ts (publication check, pick lists, swap warnings) reads
  // the windows through resolveWindowWeeks.
  it.each([
    ['one pooled window', { windowWeeks: 3 }],
    ['both windows of their own', { windowWeeks: 2, windowWeeksAvond: 3, windowWeeksWeekendFeestdag: 1 }],
    ['no window at all', { windowWeeks: 0, windowWeeksAvond: 0, windowWeeksWeekendFeestdag: 0 }],
  ])('%s', async (_label, rules) => {
    buildPeriod('GELIJK', rules);
    const input = await generate();
    expect(solverWindows(input.rules)).toEqual(resolveWindowWeeks(rules));
  });

  // Audit 7: PATCH .../ruleset accepts one per-teller window without the
  // other. The solver read the missing one as 0 (no window, and no floor
  // between avond- and weekenddiensten either), while the app falls back to
  // windowWeeks for it - so the publication check warned about
  // weekenddiensten the solver had been told were fine.
  it('only the avond window set', async () => {
    const rules = { windowWeeks: 3, windowWeeksAvond: 2 };
    buildPeriod('GELIJK', rules);
    const input = await generate();
    expect(solverWindows(input.rules)).toEqual(resolveWindowWeeks(rules));
  });
});
