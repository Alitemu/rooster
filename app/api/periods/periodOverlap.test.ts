import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { softDeletePeriod } from '@/lib/periodTrash';
import { POST as createPeriod } from '@/app/api/planner/periods/route';
import { POST as openPeriod } from './[id]/open/route';
import { POST as restorePeriod } from './[id]/restore/route';

/**
 * The rule: every day belongs to at most one period of a pool (audit 12).
 *
 * Opening rounds the start back to the Monday of its week. A next period
 * typed to start on Wednesday 1 September, after one that ran to Sunday 5
 * September, began on Monday 30 August: that week had slots in both
 * periods, both rosters filled them, and two people stood on the same
 * achterwacht day. Nothing checked for overlap, and CLAUDE.md's "days
 * already assigned in published previous periods are excluded" had no code
 * behind it. A period being made (CONCEPT) or in the prullenbak takes no
 * days.
 *
 * P0 runs 2034-08-07 (Monday) to 2034-09-03 (Sunday).
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

function request(url: string, body: unknown): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const RULESET = { windowWeeks: 2, bandAvond: [0, 9], bandWeekend: [0, 9], bandFeestdag: [0, 9] };

function concept(start: string, eind: string): string {
  return insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: `Concept ${start}`,
    start_datum: start,
    eind_datum: eind,
    deadline: '2034-07-01T12:00',
    status: 'CONCEPT',
    aangemaakt_op: new Date().toISOString(),
  });
}

const open = (periodId: string, start: string, eind: string) =>
  openPeriod(request(`/api/periods/${periodId}/open`, { naam: 'Volgende', start_datum: start, eind_datum: eind, deadline: '2034-07-01T12:00', ruleset: RULESET }), {
    params: Promise.resolve({ id: periodId }),
  });

const create = (start: string, eind: string) =>
  createPeriod(request('/api/planner/periods', { naam: `Nieuw ${start}`, pool_id: ids.pool, start_datum: start, eind_datum: eind, deadline: '2034-07-01T12:00' }));

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Overlap', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Overlap', ruleset_id: ruleset, aangemaakt_op: now });
  ids.otherPool = insert('dienstrooster_pool', { naam: 'Andere', ruleset_id: ruleset, aangemaakt_op: now });
  for (const [naam, teller] of [['Avonddienst', 'AVOND'], ['Zaterdag', 'WEEKEND'], ['Zondag', 'WEEKEND'], ['Feestdag', 'FEESTDAG']]) {
    insert('dienstrooster_shift_type', { pool_id: ids.pool, naam, teller });
  }
  for (let i = 0; i < 4; i++) {
    const person = insert('dienstrooster_person', { codenaam: `Overlap-${i}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: person, pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Overlap-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
  ids.p0 = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: 'Zomer',
    start_datum: '2034-08-07',
    eind_datum: '2034-09-03',
    deadline: '2034-07-01T12:00',
    status: 'GEPUBLICEERD',
    gepubliceerd_op: now,
    aangemaakt_op: now,
  });
  // Another pool's period on the same days takes nothing from this one.
  insert('dienstrooster_schedule_period', {
    pool_id: ids.otherPool,
    naam: 'Elders',
    start_datum: '2034-08-07',
    eind_datum: '2034-10-01',
    deadline: '2034-07-01T12:00',
    status: 'OPEN',
    aangemaakt_op: now,
  });
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('every day belongs to at most one period of a pool', () => {
  it('refuses to open a period whose rounded start falls in the one before', async () => {
    const next = concept('2034-08-30', '2034-10-29');
    // Wednesday 30 August rounds back to Monday 28 August: P0's last week.
    const res = await open(next, '2034-08-30', '2034-10-29');
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toMatch(/Zomer/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_shift_slot WHERE period_id = ?').get(next) as { n: number }).n).toBe(0);
  });

  it('opens one that starts the Monday after', async () => {
    const next = concept('2034-09-04', '2034-10-29');
    expect((await open(next, '2034-09-04', '2034-10-29')).status).toBe(200);
  });

  it('refuses to make one on days another period already has, not on days only a draft or the prullenbak has', async () => {
    expect((await create('2034-08-21', '2034-09-17')).status).toBe(409);
    // The draft and the opened period above don't stand in the way of
    // what comes after them; a period in the prullenbak takes no days.
    const trashed = insert('dienstrooster_schedule_period', {
      pool_id: ids.pool,
      naam: 'Weg',
      start_datum: '2034-11-06',
      eind_datum: '2034-12-03',
      deadline: '2034-07-01T12:00',
      status: 'OPEN',
      aangemaakt_op: new Date().toISOString(),
    });
    softDeletePeriod(trashed, ids.planner);
    expect((await create('2034-11-06', '2034-12-03')).status).toBe(201);
  });

  // Audit 13: a period in the prullenbak takes no days, so another could be
  // opened on them meanwhile - and "Terugzetten" then put two periods on
  // the same days after all, both rosters filling them.
  it('refuses to restore a period onto days another one took while it was in the prullenbak', async () => {
    const restore = (periodId: string) => restorePeriod(request(`/api/periods/${periodId}/restore`, {}), { params: Promise.resolve({ id: periodId }) });
    const trashed = insert('dienstrooster_schedule_period', {
      pool_id: ids.pool,
      naam: 'Oud',
      start_datum: '2035-01-01',
      eind_datum: '2035-01-28',
      deadline: '2034-07-01T12:00',
      status: 'OPEN',
      aangemaakt_op: new Date().toISOString(),
    });
    softDeletePeriod(trashed, ids.planner);
    const draft = concept('2035-01-15', '2035-02-25');
    softDeletePeriod(draft, ids.planner);
    const next = concept('2035-01-15', '2035-02-25');
    expect((await open(next, '2035-01-15', '2035-02-25')).status).toBe(200);

    const res = await restore(trashed);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('PERIOD_OVERLAP');
    expect(body.error.message).toMatch(/Volgende/);
    const row = db.prepare('SELECT verwijderd_op FROM dienstrooster_schedule_period WHERE id = ?').get(trashed) as { verwijderd_op: string | null };
    expect(row.verwijderd_op).not.toBeNull();
    // A draft takes no days, so it comes back whatever its dates.
    expect((await restore(draft)).status).toBe(200);
  });
});
