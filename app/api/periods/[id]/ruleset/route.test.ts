import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { checkPeriodAcceptsInput } from '@/lib/periodInputGate';
import { PATCH } from './route';

/**
 * The rule: changing the venster or streefbereik of a generated roster
 * makes it wait for a new generation - it never opens the preferences
 * again (audit 11).
 *
 * Generating closes the preferences (they are only taken while OPEN), and
 * "Rooster verwijderen" goes back to GESLOTEN for the same reason. This
 * route went back to OPEN: whoever changed the window in the generation
 * dialog of a roster made before the deadline - or after closing early -
 * and then saw the generation fail, had a period open for preferences
 * again without knowing it.
 */

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

function patch(periodId: string, body: unknown) {
  const token = createSessionToken(
    { kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return PATCH(
    new NextRequest(`http://localhost/api/periods/${periodId}/ruleset`, {
      method: 'PATCH',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: periodId }) }
  );
}

const statusOf = (id: string) =>
  db.prepare('SELECT status, deadline FROM dienstrooster_schedule_period WHERE id = ?').get(id) as { status: string; deadline: string };

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const rules = { windowWeeks: 2, bandAvond: [0, 9], bandWeekend: [0, 9], bandFeestdag: [0, 9] };
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Venster', config_json: JSON.stringify(rules), aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Venster', ruleset_id: ruleset, aangemaakt_op: now });
  ids.planner = insert('dienstrooster_person', { codenaam: `Venster-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
  for (const status of ['GEGENEREERD', 'GESLOTEN', 'OPEN']) {
    ids[status] = insert('dienstrooster_schedule_period', {
      pool_id: ids.pool,
      naam: `Venster ${status}`,
      start_datum: '2036-01-07',
      eind_datum: '2036-02-03',
      // The deadline is still ahead: an OPEN period takes preferences.
      deadline: '2035-12-15T17:00',
      status,
      bevroren_ruleset_json: JSON.stringify(rules),
      aangemaakt_op: now,
    });
  }
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('PATCH /api/periods/[id]/ruleset', () => {
  it('sends a generated roster back to gesloten, not open', async () => {
    const res = await patch(ids.GEGENEREERD, { windowWeeks: 3 });
    expect(res.status).toBe(200);
    const period = statusOf(ids.GEGENEREERD);
    expect(period.status).toBe('GESLOTEN');
    expect(checkPeriodAcceptsInput(period, new Date('2035-12-01T12:00:00Z')).allowed).toBe(false);
  });

  it('leaves gesloten and open as they are', async () => {
    expect((await patch(ids.GESLOTEN, { windowWeeks: 3 })).status).toBe(200);
    expect(statusOf(ids.GESLOTEN).status).toBe('GESLOTEN');
    expect((await patch(ids.OPEN, { windowWeeks: 3 })).status).toBe(200);
    expect(statusOf(ids.OPEN).status).toBe('OPEN');
  });
});
