import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';

/**
 * The rule: whatever the address bar holds, a GET answers with something
 * other than a 500 (audit 12).
 *
 * routeInput.test.ts proves it for request bodies. Query strings are the
 * other way in: audit 11 found `?limit=abc` making a participant's notices
 * answer 500. Every GET route that reads a query parameter is called here,
 * with real ids in its path (so it gets past "not found" to the part that
 * reads the parameter) and each parameter it reads set to one odd value
 * after another - as the beheerder, or for a participant's own routes as
 * that participant. A new route or parameter is covered without anyone
 * remembering to.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const routeModules = import.meta.glob('./**/route.ts', { eager: true }) as unknown as Record<string, Record<string, unknown>>;
const apiRoot = path.join(process.cwd(), 'app/api');

const ODD = ['abc', '-1', '0', '1e309', '99999999999999999999', '', ' ', '2027-02-30', '9999-12-31', "x' OR '1'='1", '%00', 'null', 'NaN', '[]', '{}'];

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

function cookie(kind: 'person' | 'staff', personId: string): string {
  return `${SESSION_COOKIE_NAME}=${createSessionToken({ kind, personId, sessionVersion: getSessionVersion(personId)! } as never, STAFF_SESSION_MAX_AGE_SECONDS)}`;
}

interface QueryRoute {
  path: string;
  handler: Handler;
  query: string[];
}

/** GET routes and the query parameters their source reads. */
function queryRoutes(): QueryRoute[] {
  return Object.entries(routeModules)
    .filter(([, mod]) => typeof mod.GET === 'function')
    .map(([file, mod]) => {
      const routePath = file.replace(/^\.\//, '').replace(/\/route\.ts$/, '');
      const src = fs.readFileSync(path.join(apiRoot, routePath, 'route.ts'), 'utf8');
      const query = [...new Set([...src.matchAll(/searchParams\.get\('([\w-]+)'\)/g)].map((m) => m[1]))];
      return { path: routePath, handler: mod.GET as Handler, query };
    })
    .filter((r) => r.query.length > 0);
}

/** Real ids for the route's path, so it gets as far as reading its parameters. */
function fill(routePath: string): { url: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const url = routePath.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    let value: string = crypto.randomUUID();
    if (name === 'id') value = routePath.startsWith('person/') ? ids.person : routePath.startsWith('planner/pool') ? ids.pool : ids.period;
    else if (name === 'period-id' || name === 'periodId') value = ids.period;
    else if (name === 'slotId') value = ids.slot;
    else if (name === 'assignment-id') value = ids.assignment;
    params[name] = value;
    return value;
  });
  return { url: `http://localhost/api/${url}`, params };
}

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Query', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Query', ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: 'Query',
    start_datum: '2032-01-05',
    eind_datum: '2032-01-18',
    deadline: '2031-12-01T12:00',
    status: 'OPEN',
    bevroren_ruleset_json: JSON.stringify({ windowWeeks: 2, bandAvond: [0, 9], bandWeekend: [0, 9], bandFeestdag: [0, 9] }),
    aangemaakt_op: now,
  });
  ids.slot = insert('dienstrooster_shift_slot', { period_id: ids.period, shift_type_id: avond, datum: '2032-01-06', iso_jaar: 2032, iso_week: 2, is_feestdag: 0, benodigd_aantal_personen: 1 });
  ids.person = insert('dienstrooster_person', { codenaam: `Query-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  insert('dienstrooster_pool_membership', { person_id: ids.person, pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  insert('dienstrooster_person_access_link', { person_id: ids.person, token_hash: crypto.randomUUID(), geldt_voor_periode_id: ids.period, aangemaakt_op: now });
  ids.assignment = insert('dienstrooster_assignment', { schedule_version_id: ids.period, person_id: ids.person, slot_id: ids.slot, bron: 'MANUAL', row_version: 1, aangemaakt_op: now });
  ids.admin = insert('dienstrooster_person', { codenaam: `Query-beheerder-${crypto.randomUUID().slice(0, 6)}`, rol: 'ADMIN', actief: 1, aangemaakt_op: now });
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('no GET answers 500 to an odd query string', () => {
  it('finds the routes that read one', () => {
    expect(queryRoutes().length).toBeGreaterThan(10);
  });

  it.each(queryRoutes().map((r) => [r.path, r] as const))('%s', async (_name, route) => {
    const { url, params } = fill(route.path);
    const who = route.path.startsWith('person/') ? cookie('person', ids.person) : cookie('staff', ids.admin);
    const failures: string[] = [];
    for (const name of route.query) {
      for (const value of ODD) {
        const query = `?${name}=${encodeURIComponent(value)}`;
        const res = await route.handler(new NextRequest(`${url}${query}`, { headers: { Cookie: who } }), {
          params: Promise.resolve(params),
        });
        if (res.status >= 500) failures.push(`${query} -> ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
