import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fc from 'fast-check';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';

/**
 * The rule: whatever a signed-in user sends, no route answers 500. Wrong
 * input is the user's to fix and gets a 4xx with a Dutch message; a 500
 * says the server broke, logs a stack and tells the user nothing useful.
 *
 * Every mutating handler under app/api is called - as a beheerder, and on
 * the participant routes as that participant - against a real period with
 * slots, people and assignments, so the input gets past "not found". The
 * field names come from each route's own source (the type it passes to
 * parseJsonBody, and every `body.x` it reads), the values from a mix of
 * wrong types, edge cases and real ids.
 *
 * Whatever the routes write is rolled back afterwards: every row added to
 * any table after the fixture was built is deleted again.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const routeModules = import.meta.glob('./**/route.ts', { eager: true }) as unknown as Record<string, Record<string, unknown>>;
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

const f: Record<string, string> = {};
let rowidsBefore: Map<string, number>;

function insert(table: string, row: Record<string, unknown>): string {
  const id = (row.id as string) ?? crypto.randomUUID();
  const cols = Object.keys({ id, ...row });
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
    ...cols.map((c) => (c === 'id' ? id : (row[c] as never)))
  );
  return id;
}

function tables(): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`).all() as Array<{ name: string }>).map(
    (t) => t.name
  );
}

function maxRowids(): Map<string, number> {
  return new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
}

beforeAll(() => {
  rowidsBefore = maxRowids();
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Invoer', config_json: JSON.stringify({ windowWeeks: 2 }), aangemaakt_op: now });
  f.pool = insert('dienstrooster_pool', { naam: 'Invoer-pool', ruleset_id: ruleset, aangemaakt_op: now });
  f.period = insert('dienstrooster_schedule_period', {
    pool_id: f.pool,
    naam: 'Invoer-periode',
    start_datum: '2027-01-04',
    eind_datum: '2027-01-31',
    deadline: '2099-01-01T00:00',
    status: 'OPEN',
    bevroren_ruleset_json: JSON.stringify({ windowWeeks: 2 }),
    aangemaakt_op: now,
  });
  const avond = insert('dienstrooster_shift_type', { pool_id: f.pool, naam: 'Avond-invoer', teller: 'AVOND' });
  const people = ['Invoer-A', 'Invoer-B', 'Invoer-C'].map((codenaam) => {
    const id = insert('dienstrooster_person', { codenaam: `${codenaam}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_person_access_link', { person_id: id, token_hash: crypto.randomBytes(32).toString('hex'), geldt_voor_periode_id: f.period, aangemaakt_op: now });
    f[`membership_${codenaam}`] = insert('dienstrooster_pool_membership', {
      person_id: id,
      pool_id: f.pool,
      deelnamefactor: 1,
      geldig_vanaf: '2020-01-01',
      geldig_tot: '2099-12-31',
    });
    return id;
  });
  [f.personA, f.personB] = people;
  f.membership = f['membership_Invoer-A'];
  const dates = ['2027-01-04', '2027-01-11', '2027-01-18', '2027-01-25'];
  const slots = dates.map((datum, i) =>
    insert('dienstrooster_shift_slot', { period_id: f.period, datum, iso_jaar: 2027, iso_week: i + 1, shift_type_id: avond })
  );
  f.slot = slots[0];
  f.avond = avond;
  f.assignment = insert('dienstrooster_assignment', {
    schedule_version_id: f.period,
    person_id: f.personA,
    slot_id: slots[0],
    bron: 'SOLVER',
    row_version: 1,
    aangemaakt_op: now,
  });
  insert('dienstrooster_assignment', { schedule_version_id: f.period, person_id: f.personB, slot_id: slots[2], bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  f.admin = insert('dienstrooster_person', { codenaam: `Invoer-admin-${crypto.randomUUID().slice(0, 6)}`, rol: 'ADMIN', actief: 1, aangemaakt_op: now });
});

afterAll(() => {
  // Undo every insert made since the snapshot, in any table, whatever route made it.
  db.pragma('foreign_keys = OFF');
  try {
    for (const [table, max] of maxRowids()) {
      db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
      void max;
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

/** Field names the route reads from its body, from its own source. */
function bodyKeys(file: string): string[] {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const keys = new Set<string>();
  for (const m of src.matchAll(/parseJsonBody<\{([^>]*)\}>/g)) {
    for (const k of m[1].matchAll(/(\w+)\??\s*:/g)) keys.add(k[1]);
  }
  for (const m of src.matchAll(/\bbody\??\.(\w+)/g)) keys.add(m[1]);
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*(?:body|await parseJsonBody)/g)) {
    for (const k of m[1].split(',')) {
      const name = k.split(/[:=]/)[0].trim();
      if (/^\w+$/.test(name)) keys.add(name);
    }
  }
  return [...keys];
}

/** An assignment of its own for each call, so one call reassigning it never leaves the next with a 404. */
let extraWeek = 10;
function freshAssignment(): string {
  const week = extraWeek++;
  const slot = insert('dienstrooster_shift_slot', { period_id: f.period, datum: '2027-01-27', iso_jaar: 2027, iso_week: week, shift_type_id: f.avond });
  return insert('dienstrooster_assignment', {
    schedule_version_id: f.period,
    person_id: f.personA,
    slot_id: slot,
    bron: 'SOLVER',
    row_version: 1,
    aangemaakt_op: new Date().toISOString(),
  });
}

/** Ids for the route's own path parameters, from the fixture where they mean something. */
function params(route: string): { url: string; params: Record<string, string> } {
  const out: Record<string, string> = {};
  const url = route.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    let value: string;
    if (name === 'id') {
      value = (route.startsWith('person/') || route.startsWith('aios/deelnemer/')) ? f.personA : route.startsWith('planner/pool/') ? f.pool : route.startsWith('admin/accounts') ? f.admin : f.period;
    } else if (name === 'period-id' || name === 'periodId') value = f.period;
    else if (name === 'slotId') value = f.slot;
    else if (name === 'assignment-id') value = freshAssignment();
    else if (name === 'membershipId') value = f.membership;
    else value = crypto.randomUUID();
    out[name] = value;
    return value;
  });
  return { url: `http://localhost/api/${url}`, params: out };
}

const value = fc.oneof(
  fc.constantFrom<unknown>(
    null,
    true,
    false,
    0,
    -1,
    1.5,
    1e12,
    '',
    ' ',
    'x',
    'NaN',
    '2027-02-30',
    '2027-01-04',
    '2099-12-31T23:59',
    'ABSOLUUT',
    'AVOND',
    [],
    {},
    ['x'],
    { a: 1 },
    [{}],
    'x'.repeat(5000)
  ),
  fc.constantFrom('period', 'slot', 'personA', 'personB', 'pool', 'assignment').map((k) => f[k]),
  fc.string({ maxLength: 20 }),
  fc.integer()
);

function cookie(kind: 'person' | 'staff', personId: string): string {
  const token = createSessionToken({ kind, personId, sessionVersion: getSessionVersion(personId)! } as never, STAFF_SESSION_MAX_AGE_SECONDS);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

// Destructive ones last, so the fixture is still there for the rest.
const LAST = /purge|delete|unpublish|reopen|reset|close|publish|finalize|restore/i;
const routes = Object.entries(routeModules)
  .flatMap(([file, mod]) => {
    const route = file.replace(/^\.\//, '').replace(/\/route\.ts$/, '');
    return MUTATING.filter((m) => typeof mod[m] === 'function').map((method) => ({ file, route, method, handler: mod[method] as Handler }));
  })
  // Logging in and claiming a fresh install are covered by their own tests
  // and lock accounts or rate-limit on repeated tries.
  .filter((r) => !/^auth\/(staff-login|first-run-setup|verify-link|logout|change-password|totp)/.test(r.route) && r.route !== 'link-aanvragen' && r.route !== 'aios/link-aanvragen')
  .sort((a, b) => Number(LAST.test(`${a.method} ${a.route}`)) - Number(LAST.test(`${b.method} ${b.route}`)));

// Audit 6 found eleven routes answering 500 to a field of the wrong type
// (an object or number where text or a list belongs), the value reaching a
// loop or a database parameter unchecked: {"rows":-1}, {"period_id":{}},
// {"person_id":[]}, {"reason":1.5}, {"corrections":-1}, {"rows":{}}. They
// now answer 400 (lib/requestFields.ts); those bodies are tried first on
// every route, before the generated ones.
const AUDIT6_BODIES: Array<Record<string, unknown>> = [
  { rows: -1 },
  { rows: {} },
  { rows: [1, 'x'] },
  { rows: [{ codenaam: {}, datum: 5, teller: [] }] },
  { corrections: -1 },
  { corrections: [{ person_id: {}, aantal: 1, reden: 'x', type: 'AVOND' }] },
  { period_id: {}, offered_slot_id: 1, requested_slot_id: -1 },
  { person_id: {}, slot_id: 1e12, reason: [] },
  { person_id: [], reason: 1.5 },
  { reason: [] },
  { reason: { a: 1 } },
];

describe('no route answers 500 to wrong input from a signed-in user', () => {
  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  const check = async (r: (typeof routes)[number]) => {
    const keys = bodyKeys(r.file);
    const who = (r.route.startsWith('person/') || r.route.startsWith('aios/deelnemer/')) ? cookie('person', f.personA) : cookie('staff', f.admin);
    await fc.assert(
      fc.asyncProperty(fc.dictionary(fc.constantFrom(...(keys.length ? keys : ['x'])), value), async (body) => {
        const { url, params: p } = params(r.route);
        const req = new NextRequest(url, {
          method: r.method,
          headers: { 'Content-Type': 'application/json', Cookie: who },
          body: JSON.stringify(body),
        });
        let status: number;
        try {
          status = (await r.handler(req, { params: Promise.resolve(p) })).status;
        } catch (error) {
          throw new Error(`threw ${(error as Error).message} for ${JSON.stringify(body).slice(0, 200)}`);
        }
        expect(status, JSON.stringify(body).slice(0, 300)).not.toBe(500);
      }),
      { numRuns: 25, examples: AUDIT6_BODIES.map((b) => [b]) }
    );
  };

  it.each(routes.map((r) => [`${r.method} ${r.route}`, r] as const))('%s', (_, r) => check(r), 60_000);
});
