import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET as listMembers } from './route';

/**
 * The rule: "today" on Personeel beheren is today in the Netherlands.
 *
 * The members route takes today from toISOString(), which is UTC: from
 * midnight until one (winter) or two (summer) o'clock Dutch time it is
 * still yesterday there, so someone whose membership starts today reads
 * "Begint later" and someone whose last day was yesterday still reads
 * "Actief". Audit 9. (The container runs in Europe/Amsterdam, and so do
 * these tests; toISOString ignores both.)
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

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Vandaag', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Vandaag', ruleset_id: ruleset, aangemaakt_op: now });
  ids.starts = insert('dienstrooster_person', { codenaam: `Vandaag-begint-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  ids.ended = insert('dienstrooster_person', { codenaam: `Vandaag-gestopt-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  insert('dienstrooster_pool_membership', { person_id: ids.starts, pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2026-10-14', geldig_tot: '2029-12-31' });
  insert('dienstrooster_pool_membership', { person_id: ids.ended, pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2026-10-13' });
  ids.planner = insert('dienstrooster_person', { codenaam: `Vandaag-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

async function activeAt(instant: string): Promise<Record<string, boolean>> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(instant));
  // Issued on the moved clock too: a staff session from "now" may have
  // expired by the instant asked for.
  const token = createSessionToken({ kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never, STAFF_SESSION_MAX_AGE_SECONDS);
  const res = await listMembers(
    new NextRequest(`http://localhost/api/planner/pool/${ids.pool}/members`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` } }),
    { params: Promise.resolve({ id: ids.pool }) }
  );
  vi.useRealTimers();
  const rows = ((await res.json()) as { data: Array<{ person_id: string; is_active: boolean | number }> }).data;
  return Object.fromEntries(rows.map((r) => [r.person_id === ids.starts ? 'begint' : 'gestopt', Boolean(r.is_active)]));
}

describe('Personeel beheren counts today in Dutch time', () => {
  it('at noon on 14 October: the one starting is active, the one who stopped on the 13th is not', async () => {
    expect(await activeAt('2026-10-14T10:00:00Z')).toEqual({ begint: true, gestopt: false });
  });

  // Audit 9: at 00:30 Dutch time (22:30 UTC the day before) the route
  // still reads the 13th: { begint: false, gestopt: true }.
  it.fails('half past midnight on 14 October, Dutch time, is already the 14th', async () => {
    expect(await activeAt('2026-10-13T22:30:00Z')).toEqual({ begint: true, gestopt: false });
  });
});
