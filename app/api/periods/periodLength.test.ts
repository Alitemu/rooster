import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST as createPeriod } from '@/app/api/planner/periods/route';
import { POST as openPeriod } from './[id]/open/route';
import { GET as capacity } from './[id]/capacity/route';

/**
 * The rule: a period is at most two years long (lib/isoDate.ts
 * MAX_PERIODE_DAGEN), wherever its dates come in (audit 11).
 *
 * Every day of a period becomes a slot. There was no limit: a year typed
 * as 2207 instead of 2027 gave a period of 180 years, 66,000 slots when it
 * opened and an invitation to fill them in; and the setup wizard's live
 * capacity check took start and end straight from the address and worked
 * through every day in between, on the one thread that serves everyone.
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

function request(url: string, method: string, body?: unknown): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const RULESET = { windowWeeks: 2, bandAvond: [0, 9], bandWeekend: [0, 9], bandFeestdag: [0, 9] };

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Lengte', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Lengte', ruleset_id: ruleset, aangemaakt_op: now });
  for (const [naam, teller] of [['Avonddienst', 'AVOND'], ['Zaterdag', 'WEEKEND'], ['Zondag', 'WEEKEND'], ['Feestdag', 'FEESTDAG']]) {
    insert('dienstrooster_shift_type', { pool_id: ids.pool, naam, teller });
  }
  for (let i = 0; i < 4; i++) {
    const person = insert('dienstrooster_person', { codenaam: `Lengte-${i}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: person, pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Lengte-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: 'Lengte',
    start_datum: '2031-01-06',
    eind_datum: '2031-06-29',
    deadline: '2030-12-01T12:00',
    status: 'CONCEPT',
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

describe('a period is at most two years long', () => {
  it('when it is made', async () => {
    const create = (eind: string) =>
      createPeriod(request('/api/planner/periods', 'POST', { naam: `Lengte ${eind}`, pool_id: ids.pool, start_datum: '2031-01-06', eind_datum: eind, deadline: '2030-12-01T12:00' }));
    const typo = await create('2041-01-05');
    expect(typo.status).toBe(400);
    expect(JSON.stringify(await typo.json())).toMatch(/hoogstens twee jaar/);
    expect((await create('2032-06-27')).status).toBe(201); // a year and a half
  });

  it('when it is opened', async () => {
    const res = await openPeriod(
      request(`/api/periods/${ids.period}/open`, 'POST', { naam: 'Lengte', start_datum: '2031-01-06', eind_datum: '2041-01-05', deadline: '2030-12-01T12:00', ruleset: RULESET }),
      { params: Promise.resolve({ id: ids.period }) }
    );
    expect(res.status).toBe(400);
    const slots = db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_shift_slot WHERE period_id = ?').get(ids.period) as { n: number };
    expect(slots.n).toBe(0);
  });

  it('in the live capacity check, which also wants real dates', async () => {
    const check = (query: string) => capacity(request(`/api/periods/${ids.period}/capacity${query}`, 'GET'), { params: Promise.resolve({ id: ids.period }) });
    expect((await check('?start_datum=2031-01-06&eind_datum=2041-01-05')).status).toBe(400);
    expect((await check('?start_datum=2031-01-06&eind_datum=abc')).status).toBe(400);
    expect((await check('?start_datum=2031-01-06&eind_datum=2031-06-29')).status).toBe(200);
    expect((await check('')).status).toBe(200);
  });

  it('answers 400 and not 500 for a pool_id that is not text', async () => {
    for (const pool_id of [{ id: 1 }, 7, ['a']]) {
      const res = await createPeriod(
        request('/api/planner/periods', 'POST', { naam: 'Pool', pool_id, start_datum: '2031-01-06', eind_datum: '2031-02-02', deadline: '2030-12-01T12:00' })
      );
      expect(res.status).toBe(400);
    }
  });
});
