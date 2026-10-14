import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { softDeletePeriod } from '@/lib/periodTrash';
import { GET as roster } from './[id]/roster/[period-id]/route';
import { POST as createSwap } from './[id]/swap-requests/route';
import { POST as approveSwap } from './[id]/swap-requests/[swap-id]/approve/route';
import { POST as rejectSwap } from './[id]/swap-requests/[swap-id]/reject/route';
import { POST as cancelSwap } from './[id]/swap-requests/[swap-id]/cancel/route';

/**
 * The rule (CLAUDE.md, the prullenbak): a published period put in the
 * prullenbak is gone for its participants at once.
 *
 * verify-link, the preferences and the colleagues' roster held to it
 * (lib/periodAccess.ts), but the participant's own roster still answered,
 * and a swap could still be asked, approved, rejected or withdrawn: it
 * moved shifts in a roster nobody can see and mailed colleagues about it
 * (audit 13).
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

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

function call(handler: unknown, url: string, personId: string, params: Record<string, string>, body?: unknown) {
  const token = createSessionToken({ kind: 'person', personId, sessionVersion: getSessionVersion(personId)! } as never, PERSON_SESSION_MAX_AGE_SECONDS);
  return (handler as Handler)(
    new NextRequest(`http://localhost${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) }
  );
}

const holder = (slotId: string) =>
  (db.prepare('SELECT person_id FROM dienstrooster_assignment WHERE slot_id = ?').get(slotId) as { person_id: string }).person_id;

beforeAll(async () => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Prullenbak', config_json: '{}', aangemaakt_op: now });
  const pool = insert('dienstrooster_pool', { naam: 'Prullenbak', ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: pool, naam: 'Avond', teller: 'AVOND' });
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: 'Weggegooid',
    start_datum: '2099-03-02',
    eind_datum: '2099-04-26',
    deadline: '2099-01-01T00:00',
    status: 'GEPUBLICEERD',
    bevroren_ruleset_json: '{"windowWeeks":2}',
    aangemaakt_op: now,
  });
  const person = () => {
    const id = insert('dienstrooster_person', { codenaam: `Prul-${crypto.randomUUID().slice(0, 8)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_person_access_link', { person_id: id, geldt_voor_periode_id: ids.period, token_hash: hashToken(crypto.randomUUID()), aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
    return id;
  };
  const shift = (personId: string, datum: string, week: number) => {
    const slot = insert('dienstrooster_shift_slot', { period_id: ids.period, shift_type_id: avond, datum, iso_jaar: 2099, iso_week: week, is_feestdag: 0, benodigd_aantal_personen: 1 });
    insert('dienstrooster_assignment', { schedule_version_id: ids.period, person_id: personId, slot_id: slot, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
    return slot;
  };
  ids.a = person();
  ids.b = person();
  ids.slotA = shift(ids.a, '2099-03-03', 10);
  ids.slotB = shift(ids.b, '2099-04-13', 16);
  ids.slotA2 = shift(ids.a, '2099-03-24', 13);

  // Three requests while the roster could still be seen.
  const ask = async (offered: string, requested: string) => {
    const res = await call(createSwap, `/api/person/${ids.a}/swap-requests`, ids.a, { id: ids.a }, { period_id: ids.period, offered_slot_id: offered, requested_slot_id: requested });
    expect(res.status).toBe(200);
    return (await res.json()).data.swap_request_id as string;
  };
  ids.toApprove = await ask(ids.slotA, ids.slotB);
  ids.toCancel = await ask(ids.slotA2, ids.slotB);

  softDeletePeriod(ids.period, ids.a);
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('a published period in the prullenbak is gone for its participants', () => {
  it('shows no roster', async () => {
    const res = await call(roster, `/api/person/${ids.a}/roster/${ids.period}`, ids.a, { id: ids.a, 'period-id': ids.period });
    expect(res.status).toBe(404);
  });

  it('takes no new swap request', async () => {
    const res = await call(createSwap, `/api/person/${ids.b}/swap-requests`, ids.b, { id: ids.b }, { period_id: ids.period, offered_slot_id: ids.slotB, requested_slot_id: ids.slotA2 });
    expect(res.status).toBe(404);
  });

  it('approves, rejects or withdraws nothing, and moves no shift', async () => {
    for (const [handler, who, swap] of [
      [approveSwap, ids.b, ids.toApprove],
      [rejectSwap, ids.b, ids.toApprove],
      [cancelSwap, ids.a, ids.toCancel],
    ] as const) {
      const res = await call(handler, `/api/person/${who}/swap-requests/${swap}/x`, who, { id: who, 'swap-id': swap }, {});
      expect(res.status).toBe(404);
    }
    expect(holder(ids.slotA)).toBe(ids.a);
    expect(holder(ids.slotB)).toBe(ids.b);
    const statuses = db.prepare('SELECT status FROM dienstrooster_swap_request WHERE periode_id = ?').all(ids.period) as Array<{ status: string }>;
    expect(statuses.map((s) => s.status)).toEqual(['PENDING', 'PENDING']);
  });
});
