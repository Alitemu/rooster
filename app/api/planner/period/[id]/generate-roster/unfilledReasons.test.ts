import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { getRosterGenerationJob } from '@/lib/rosterGenerationJobs';
import { POST as generate } from './route';

/**
 * The rule: a generation that leaves shifts empty says why, where that is
 * certain - nobody is a member of the pool that day (Geldig vanaf/tot),
 * every member blocked it, or the streefbereik's maximums together are
 * fewer than the shifts.
 *
 * Reported by the planner: 15 people, a period of 36 weeks, 160 empty
 * shifts with every planner and even without a window, and only "not
 * enough people available" to go on. The memberships ending halfway the
 * period explains exactly that, and nothing on screen said so.
 *
 * A fake solver leaves every shift empty; the route has to tell the
 * causes apart on its own.
 */

const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;
let server: http.Server;
let slotsSent: string[] = [];
let preferencesSent: Record<string, Array<{ slot_id: string; blocking_level: string }>> = {};
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

beforeAll(async () => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const rules = { windowWeeks: 0, bandAvond: [1, 1], bandWeekend: [0, 0], bandFeestdag: [0, 0] };
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Redenen', config_json: JSON.stringify(rules), aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Redenen', ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: 'Redenen',
    start_datum: '2031-01-06',
    eind_datum: '2031-01-19',
    deadline: '2030-12-01T12:00:00.000Z',
    status: 'GESLOTEN',
    bevroren_ruleset_json: JSON.stringify(rules),
    aangemaakt_op: now,
  });
  // Ten weekday avonddiensten over two weeks.
  for (let d = 0; d < 14; d++) {
    if (d % 7 >= 5) continue;
    const datum = new Date(Date.UTC(2031, 0, 6 + d)).toISOString().slice(0, 10);
    ids[datum] = insert('dienstrooster_shift_slot', { period_id: ids.period, shift_type_id: avond, datum, iso_jaar: 2031, iso_week: 2 + Math.floor(d / 7), is_feestdag: 0, benodigd_aantal_personen: 1 });
  }
  // Both members stop after the first week.
  for (const who of ['A', 'B']) {
    ids[who] = insert('dienstrooster_person', { codenaam: `Redenen-${who}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: ids[who], pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2031-01-12' });
    // And both blocked the Monday.
    insert('dienstrooster_availability', { person_id: ids[who], slot_id: ids['2031-01-06'], blocking_level: 'ABSOLUUT', source: 'MANUAL', aangemaakt_op: now });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Redenen-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });

  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const input = JSON.parse(raw);
      slotsSent = input.slots.map((s: { id: string }) => s.id);
      preferencesSent = input.person_preferences;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          success: true,
          assignments: [],
          diagnostics: { unfilled_slots: slotsSent.map((slot_id) => ({ slot_id, shortfall: 1 })), solver_status: 'OPTIMAL', total_cost: 0, violations: {}, time_seconds: 0 },
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

describe('generate-roster says why shifts stayed empty', () => {
  it('nobody a member, everyone blocked, and a streefbereik too small', async () => {
    const token = createSessionToken({ kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never, STAFF_SESSION_MAX_AGE_SECONDS);
    const res = await generate(
      new NextRequest(`http://localhost/api/planner/period/${ids.period}/generate-roster`, {
        method: 'POST',
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      { params: Promise.resolve({ id: ids.period }) }
    );
    const body = (await res.json()) as { data: { job_id: string } };
    let job = getRosterGenerationJob(body.data.job_id, ids.period);
    for (let i = 0; i < 200 && job?.status === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 25));
      job = getRosterGenerationJob(body.data.job_id, ids.period);
    }
    const result = job!.result!;
    const reden = Object.fromEntries(result.unfilled_slots.map((u) => [u.datum, u.reden]));

    // Second week: both memberships ended on the 12th.
    for (const datum of ['2031-01-13', '2031-01-14', '2031-01-15', '2031-01-16', '2031-01-17']) expect(reden[datum]).toBe('GEEN_LID');
    // The Monday both blocked.
    expect(reden['2031-01-06']).toBe('IEDEREEN_GEBLOKKEERD');
    // The rest of the first week: people were there, the band of one each stopped them.
    for (const datum of ['2031-01-07', '2031-01-08', '2031-01-09', '2031-01-10']) expect(reden[datum]).toBeNull();
    // Two people, at most one avonddienst each (scaled for half the period:
    // still one), ten avonddiensten. Both there half the period are one
    // effective person, so the band the app would choose itself is all ten
    // (and one to spare, as its default bands always have).
    expect(result.bereik_tekort.AVOND).toEqual({ maximaal: 2, diensten: 10, voorgesteld: [10, 11] });
    expect(result.deels_lid).toBe(2);
  });

  // Audit 9's mutation check: taking blockOutsideMembership out of the
  // route left every test green - lib/membershipWindow.test.ts proves the
  // function, nothing proved the route sends its blocks. The second week,
  // after both memberships ended, has to reach the solver blocked.
  it('sends every day outside the membership to the solver as blocked', () => {
    const secondWeek = ['2031-01-13', '2031-01-14', '2031-01-15', '2031-01-16', '2031-01-17'].map((d) => ids[d]);
    for (const who of ['A', 'B']) {
      const level = new Map(preferencesSent[ids[who]].map((p) => [p.slot_id, p.blocking_level]));
      for (const slot of secondWeek) expect(level.get(slot), who).toBe('ABSOLUUT');
      // The first week stays theirs: only the Monday they blocked themselves.
      expect(level.get(ids['2031-01-07']), who).not.toBe('ABSOLUUT');
    }
  });
});
