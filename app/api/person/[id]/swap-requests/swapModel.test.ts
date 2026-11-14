import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fc from 'fast-check';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST as createSwap, GET as listSwaps } from './route';
import { POST as approveSwap } from './[swap-id]/approve/route';
import { POST as rejectSwap } from './[swap-id]/reject/route';
import { POST as cancelSwap } from './[swap-id]/cancel/route';

/**
 * Swapping as a state machine, driven through the real routes.
 *
 * A small published roster, four colleagues, and random sequences of
 * requests, approvals, rejections and withdrawals - by the right person or
 * the wrong one, on open requests or ones already settled. A model keeps
 * who holds which shift and which requests are still open, and after every
 * step the database must agree with it:
 *
 * - every shift still has exactly one person, and the one the model says;
 * - only an approval by the colleague moves shifts, and it moves exactly
 *   the two in that request;
 * - an approval closes every other open request on either of its shifts,
 *   and nothing else;
 * - a request can only be answered once, and only by the right person;
 *   anything else is refused with a 4xx and changes nothing;
 * - so every request still open is one that can still go through: the
 *   requester holds what they offer, the colleague holds what was asked.
 *
 * fast-check shrinks a failure to the shortest sequence that shows it.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

interface ModelSwap {
  id: string;
  requester: string;
  respondent: string;
  offered: string;
  requested: string;
  status: 'PENDING' | 'GOEDGEKEURD' | 'CLOSED';
}

const fixture = { people: [] as string[], slots: [] as Array<{ id: string; teller: string }>, period: '', pool: '' };
let rowidsBefore: Map<string, number>;

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

function cookie(personId: string): string {
  const token = createSessionToken(
    { kind: 'person', personId, sessionVersion: getSessionVersion(personId)! },
    PERSON_SESSION_MAX_AGE_SECONDS
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

async function call(handler: unknown, actor: string, params: Record<string, string>, body?: unknown) {
  const req = new NextRequest('http://localhost/api/person/x/swap-requests', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie(actor), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** A fresh period per run: 4 people with 3 avond- and 1 weekenddienst each, all in 2099. */
function buildRoster(): Map<string, string> {
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Ruilmodel', config_json: '{}', aangemaakt_op: now });
  fixture.pool = insert('dienstrooster_pool', { naam: 'Ruilmodel', ruleset_id: ruleset, aangemaakt_op: now });
  const types = {
    AVOND: insert('dienstrooster_shift_type', { pool_id: fixture.pool, naam: 'Avond', teller: 'AVOND' }),
    WEEKEND: insert('dienstrooster_shift_type', { pool_id: fixture.pool, naam: 'Weekend', teller: 'WEEKEND' }),
  };
  fixture.period = insert('dienstrooster_schedule_period', {
    pool_id: fixture.pool,
    naam: 'Ruilmodel',
    start_datum: '2099-03-02',
    eind_datum: '2099-05-24',
    deadline: '2099-01-01T00:00',
    status: 'GEPUBLICEERD',
    definitief_op: now,
    bevroren_ruleset_json: JSON.stringify({ windowWeeks: 0 }),
    aangemaakt_op: now,
  });
  fixture.people = [0, 1, 2, 3].map((i) => {
    const id = insert('dienstrooster_person', { codenaam: `Ruil-${i}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: fixture.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
    // A participant's session is only good while they have a personal link.
    insert('dienstrooster_person_access_link', { person_id: id, token_hash: crypto.randomBytes(32).toString('hex'), geldt_voor_periode_id: fixture.period, aangemaakt_op: now });
    return id;
  });
  fixture.slots = [];
  const holder = new Map<string, string>();
  let week = 10;
  fixture.people.forEach((person, i) => {
    for (const teller of ['AVOND', 'AVOND', 'AVOND', 'WEEKEND'] as const) {
      const monday = new Date(Date.UTC(2099, 2, 2 + 7 * (week - 10)));
      const day = new Date(monday.getTime() + (teller === 'WEEKEND' ? 5 : i % 5) * 86400000);
      const slot = insert('dienstrooster_shift_slot', {
        period_id: fixture.period,
        shift_type_id: types[teller],
        datum: day.toISOString().slice(0, 10),
        iso_jaar: 2099,
        iso_week: week++,
        is_feestdag: 0,
        benodigd_aantal_personen: 1,
      });
      insert('dienstrooster_assignment', { schedule_version_id: fixture.period, person_id: person, slot_id: slot, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
      fixture.slots.push({ id: slot, teller });
      holder.set(slot, person);
    }
  });
  return holder;
}

function dbHolders(): Map<string, string> {
  const rows = db
    .prepare('SELECT slot_id, person_id FROM dienstrooster_assignment WHERE schedule_version_id = ?')
    .all(fixture.period) as Array<{ slot_id: string; person_id: string }>;
  expect(rows).toHaveLength(fixture.slots.length);
  return new Map(rows.map((r) => [r.slot_id, r.person_id]));
}

function dbStatus(id: string): string {
  return (db.prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?').get(id) as { status: string }).status;
}

type Step = [kind: number, a: number, b: number, c: number, wrong: boolean];

async function runSequence(steps: Step[]): Promise<void> {
  const holder = buildRoster();
  const swaps: ModelSwap[] = [];
  const created = new Map<string, number>();
  const people = fixture.people;

  for (const [kind, a, b, c, wrong] of steps) {
    if (kind <= 1 || swaps.length === 0) {
      // A request: requester offers one of their own shifts for someone else's.
      const requester = people[a % people.length];
      const mine = fixture.slots.filter((s) => holder.get(s.id) === requester);
      if (mine.length === 0) continue;
      const offered = mine[b % mine.length];
      const others = fixture.slots.filter((s) => holder.get(s.id) !== requester);
      const requested = others[c % others.length];
      const respondent = holder.get(requested.id)!;
      const duplicate = swaps.some(
        (s) => s.status === 'PENDING' && s.requester === requester && s.offered === offered.id && s.requested === requested.id
      );
      const res = await call(createSwap, requester, { id: requester }, {
        period_id: fixture.period,
        offered_slot_id: offered.id,
        requested_slot_id: requested.id,
      });
      expect(res.status, JSON.stringify(res.json)).toBeLessThan(500);
      const ok = offered.teller === requested.teller && !duplicate && (created.get(requester) ?? 0) < 20;
      if (ok) {
        expect(res.status, JSON.stringify(res.json)).toBeLessThan(300);
        const row = db
          .prepare(
            `SELECT id FROM dienstrooster_swap_request WHERE periode_id = ? AND aanvrager_person_id = ? AND aangeboden_slot_id = ?
             AND gevraagde_slot_id = ? AND status = 'PENDING'`
          )
          .get(fixture.period, requester, offered.id, requested.id) as { id: string };
        swaps.push({ id: row.id, requester, respondent, offered: offered.id, requested: requested.id, status: 'PENDING' });
        created.set(requester, (created.get(requester) ?? 0) + 1);
      } else {
        expect(res.status, JSON.stringify(res.json)).toBeGreaterThanOrEqual(400);
      }
    } else {
      const swap = swaps[a % swaps.length];
      const rightActor = kind === 4 ? swap.requester : swap.respondent;
      const actor = wrong ? people.find((p) => p !== rightActor && (b % 2 === 0 || p !== swap.requester))! : rightActor;
      const handler = kind === 2 ? approveSwap : kind === 3 ? rejectSwap : cancelSwap;
      const res = await call(handler, actor, { id: actor, 'swap-id': swap.id }, {});
      expect(res.status, JSON.stringify(res.json)).toBeLessThan(500);
      if (wrong || swap.status !== 'PENDING') {
        expect(res.status, `${['', '', 'approve', 'reject', 'cancel'][kind]} by ${wrong ? 'the wrong person' : 'the right person'} on ${swap.status}`).toBeGreaterThanOrEqual(400);
      } else {
        expect(res.status, JSON.stringify(res.json)).toBeLessThan(300);
        if (kind === 2) {
          holder.set(swap.offered, swap.respondent);
          holder.set(swap.requested, swap.requester);
          swap.status = 'GOEDGEKEURD';
          for (const other of swaps) {
            if (other !== swap && other.status === 'PENDING' && [other.offered, other.requested].some((s) => s === swap.offered || s === swap.requested)) {
              other.status = 'CLOSED';
            }
          }
        } else {
          swap.status = 'CLOSED';
        }
      }
    }

    // The database agrees with the model after every step.
    expect(dbHolders()).toEqual(holder);
    for (const s of swaps) {
      const status = dbStatus(s.id);
      expect({ swap: s.id, status: status === 'PENDING' || status === 'GOEDGEKEURD' ? status : 'CLOSED' }).toEqual({ swap: s.id, status: s.status });
      if (s.status === 'PENDING') {
        expect(holder.get(s.offered)).toBe(s.requester);
        expect(holder.get(s.requested)).toBe(s.respondent);
      }
    }
  }
}

beforeAll(() => {
  rowidsBefore = maxRowids();
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) {
      db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

// No Math.random here: the seed below only makes a failure reproducible when everything drawn comes from fast-check.
const stepArb = fc.tuple(fc.nat(4), fc.nat(50), fc.nat(50), fc.nat(50), fc.tuple(fc.boolean(), fc.nat(9)).map(([w, k]) => w && k < 3));

describe('swapping, as a state machine through the real routes', () => {
  it('random sequences keep shifts, requests and answers consistent', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 30 }), async (steps) => {
        await runSequence(steps as Step[]);
      }),
      { numRuns: 30, seed: 7 }
    );
  }, 120_000);
});

describe('the swap list filters', () => {
  // Audit 7: the list query read "WHERE aanvrager = ? OR respondent = ?
  // AND periode = ? AND status = ?" without brackets, so the filters only
  // applied to requests someone received. The ruilpaneel (SwapManagementPanel)
  // asks for one period and one status, and showed the participant's own
  // requests from every period and with every status.
  it('?period_id and ?status apply to requests someone made too', async () => {
    buildRoster();
    const [requester, colleague] = fixture.people;
    const mine = fixture.slots.find((s) => s.teller === 'AVOND' && dbHolders().get(s.id) === requester)!;
    const theirs = fixture.slots.find((s) => s.teller === 'AVOND' && dbHolders().get(s.id) === colleague)!;
    const made = await call(createSwap, requester, { id: requester }, {
      period_id: fixture.period,
      offered_slot_id: mine.id,
      requested_slot_id: theirs.id,
    });
    expect(made.status).toBeLessThan(300);

    const approved = await listSwaps(
      new NextRequest(`http://localhost/api/person/${requester}/swap-requests?period_id=${fixture.period}&status=GOEDGEKEURD`, {
        headers: { Cookie: cookie(requester) },
      }),
      { params: Promise.resolve({ id: requester }) }
    );
    expect(((await approved.json()) as { data: { swap_requests: unknown[] } }).data.swap_requests).toEqual([]);

    const otherPeriod = await listSwaps(
      new NextRequest(`http://localhost/api/person/${requester}/swap-requests?period_id=${crypto.randomUUID()}`, {
        headers: { Cookie: cookie(requester) },
      }),
      { params: Promise.resolve({ id: requester }) }
    );
    expect(((await otherPeriod.json()) as { data: { swap_requests: unknown[] } }).data.swap_requests).toEqual([]);
  });
});
