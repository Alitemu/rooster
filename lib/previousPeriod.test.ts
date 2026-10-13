import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from '@/db/client';
import { refreshCarryOverForPeriod } from '@/lib/carryOver';
import { softDeletePeriod, restorePeriod, purgePeriodNow } from '@/lib/periodTrash';
import { setPendingUndo, getPendingUndo } from '@/lib/pendingUndo';

/**
 * The rule: a period in the prullenbak counts for nothing until it is
 * restored. The period list lets a planner throw away a published period
 * ("Zij verliezen direct toegang tot hun rooster"), and participants no
 * longer reach it - but "the previous published period" was looked up in
 * six places without the trash, so its roster still decided the next
 * period's overloop and its last weeks still counted for the window rule,
 * until 30 days later the purge quietly changed both (audit 10).
 *
 * Two people, a band of exactly two avonddiensten. P0 (published): A did
 * 3, B did 1, so P1 carries A one fewer and B one more - but only while P0
 * is not in the trash.
 */

const RULES = { windowWeeks: 0, bandAvond: [2, 2], bandWeekend: [0, 0], bandFeestdag: [0, 0] };
const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;

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

/** A two-week period starting on `start` (a Monday), one avonddienst per listed owner. */
function period(start: string, status: string, owners: string[]): string {
  const now = new Date().toISOString();
  const id = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: `Prullenbak ${start}`,
    start_datum: start,
    eind_datum: new Date(Date.parse(`${start}T00:00:00Z`) + 13 * 86400000).toISOString().slice(0, 10),
    deadline: '2030-12-01T12:00:00.000Z',
    status,
    bevroren_ruleset_json: JSON.stringify(RULES),
    aangemaakt_op: now,
    overloop_bevestigd_op: now,
    ...(status === 'GEPUBLICEERD' ? { gepubliceerd_op: now, definitief_op: now } : {}),
  });
  owners.forEach((who, d) => {
    const datum = new Date(Date.parse(`${start}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
    const slot = insert('dienstrooster_shift_slot', { period_id: id, shift_type_id: ids.avond, datum, iso_jaar: 2033, iso_week: 1, is_feestdag: 0, benodigd_aantal_personen: 1 });
    insert('dienstrooster_assignment', { schedule_version_id: id, person_id: ids[who], slot_id: slot, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  });
  return id;
}

const carry = (periodId: string) =>
  Object.fromEntries(
    (
      db
        .prepare(`SELECT person_id, SUM(delta) AS d FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ? AND categorie = 'CARRY_OVER' GROUP BY person_id`)
        .all(periodId) as Array<{ person_id: string; d: number }>
    ).map((r) => [r.person_id === ids.A ? 'A' : 'B', r.d])
  );

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Prullenbak', config_json: JSON.stringify(RULES), aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Prullenbak', ruleset_id: ruleset, aangemaakt_op: now });
  ids.avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  for (const who of ['A', 'B']) {
    ids[who] = insert('dienstrooster_person', { codenaam: `Prullenbak-${who}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: ids[who], pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Prullenbak-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('a period in the trash is not the previous period', () => {
  it('carries nothing over while it is in the trash, and again once restored', () => {
    const p0 = period('2033-01-03', 'GEPUBLICEERD', ['A', 'A', 'A', 'B']);
    const p1 = period('2033-01-17', 'GESLOTEN', []);

    softDeletePeriod(p0, ids.planner);
    refreshCarryOverForPeriod(p1, ids.planner);
    expect(carry(p1)).toEqual({});

    restorePeriod(p0, ids.planner);
    refreshCarryOverForPeriod(p1, ids.planner);
    expect(carry(p1)).toEqual({ A: -1, B: 1 });

    // Thrown away after it was booked, with no other period before it:
    // what was booked stays, as for a roster unpublished for the moment
    // (lib/carryOver.ts) - nothing else to book in its place.
    softDeletePeriod(p0, ids.planner);
    refreshCarryOverForPeriod(p1, ids.planner);
    expect(carry(p1)).toEqual({ A: -1, B: 1 });
  });

  it('books from the period before it instead, as if it never existed', () => {
    // P0 left A one short; P1 (published) settled everything; P2 is next.
    period('2033-04-04', 'GEPUBLICEERD', ['A', 'B', 'B', 'B']);
    const p1 = period('2033-04-18', 'GEPUBLICEERD', ['A', 'A', 'A', 'B', 'B', 'B']);
    const p2 = period('2033-05-02', 'GESLOTEN', []);
    refreshCarryOverForPeriod(p2, ids.planner);
    expect(carry(p2)).toEqual({ A: -1, B: -1 });
    softDeletePeriod(p1, ids.planner);
    refreshCarryOverForPeriod(p2, ids.planner);
    expect(carry(p2)).toEqual({ A: 1, B: -1 });
  });

  it('dates a carry-over row like every other ledger row (ISO 8601)', () => {
    const p0 = period('2033-02-07', 'GEPUBLICEERD', ['A', 'A', 'A', 'B']);
    const p1 = period('2033-02-21', 'GESLOTEN', []);
    refreshCarryOverForPeriod(p1, ids.planner);
    const dates = db
      .prepare(`SELECT aangemaakt_op FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ? AND categorie = 'CARRY_OVER'`)
      .all(p1) as Array<{ aangemaakt_op: string }>;
    expect(dates.length).toBe(2);
    // datetime('now') wrote "2033-02-21 10:00:00": sorted as text among the
    // others ("...T...Z") it lands before every row of the same day.
    for (const d of dates) expect(d.aangemaakt_op).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    softDeletePeriod(p0, ids.planner);
  });

  it('leaves nothing of a purged period behind, its pending undo included', () => {
    const p = period('2033-03-07', 'GEGENEREERD', ['A']);
    db.transaction(() =>
      setPendingUndo({
        scope: 'PERIOD_ASSIGNMENT',
        scopeId: p,
        actionType: 'REMOVE',
        payload: {},
        label: 'test',
        actorId: ids.planner,
      })
    )();
    softDeletePeriod(p, ids.planner);
    purgePeriodNow(p, ids.planner);
    expect(getPendingUndo(p)).toBeUndefined();
  });
});

describe('every lookup of the previous published period skips the trash', () => {
  // Static on purpose, like auditCoverage: a seventh place that looks up
  // "the previous published period" itself would bring the bug back. They
  // all go through lib/previousPeriod.ts.
  it('no route or module queries it on its own', () => {
    const roots = ['app', 'lib'].map((d) => path.join(process.cwd(), d));
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []
      );
    const offenders = roots
      .flatMap(walk)
      .filter((file) => !file.endsWith(path.join('lib', 'previousPeriod.ts')))
      .filter((file) => /status\s*=\s*'GEPUBLICEERD'\s+AND\s+eind_datum\s*</.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(process.cwd(), file));
    expect(offenders).toEqual([]);
  });
});
