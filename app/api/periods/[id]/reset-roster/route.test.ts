import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { getPendingUndo, setPendingUndo } from '@/lib/pendingUndo';
import { POST as resetRoster } from './route';

/**
 * The rule: a generated roster can be removed, taking the period back to
 * GESLOTEN, ready to be generated afresh - never a roster participants
 * have seen. What a planner put in by hand stays unless they say so.
 */

let rowidsBefore: Map<string, number>;
const ids: Record<string, string> = {};

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

/** A period in `status` with three avonddiensten: two from the solver, one filled in by hand. */
function period(status: string): string {
  const now = new Date().toISOString();
  const id = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: `Reset ${status}`,
    start_datum: '2031-03-03',
    eind_datum: '2031-03-09',
    deadline: '2030-12-01T12:00:00.000Z',
    status,
    aangemaakt_op: now,
    ...(status === 'GEPUBLICEERD' ? { gepubliceerd_op: now } : {}),
  });
  ['SOLVER', 'SOLVER', 'MANUAL'].forEach((bron, d) => {
    const slot = insert('dienstrooster_shift_slot', {
      period_id: id,
      shift_type_id: ids.avond,
      datum: `2031-03-0${3 + d}`,
      iso_jaar: 2031,
      iso_week: 10,
      is_feestdag: 0,
      benodigd_aantal_personen: 1,
    });
    insert('dienstrooster_assignment', { schedule_version_id: id, person_id: ids.member, slot_id: slot, bron, row_version: 1, aangemaakt_op: now });
  });
  return id;
}

function call(periodId: string, body?: unknown, cookie = ids.plannerCookie) {
  return resetRoster(
    new NextRequest(`http://localhost/api/periods/${periodId}/reset-roster`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id: periodId }) }
  );
}

const assignments = (periodId: string) =>
  (db.prepare('SELECT bron FROM dienstrooster_assignment WHERE schedule_version_id = ? ORDER BY bron').all(periodId) as Array<{ bron: string }>).map((r) => r.bron);
const periodRow = (periodId: string) =>
  db.prepare('SELECT status, row_version FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as { status: string; row_version: number };

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Reset', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Reset', ruleset_id: ruleset, aangemaakt_op: now });
  ids.avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  ids.member = insert('dienstrooster_person', { codenaam: `Reset-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  insert('dienstrooster_person_access_link', { person_id: ids.member, token_hash: crypto.randomBytes(32).toString('hex'), aangemaakt_op: now });
  ids.planner = insert('dienstrooster_person', { codenaam: `Reset-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
  ids.plannerCookie = `${SESSION_COOKIE_NAME}=${createSessionToken({ kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never, STAFF_SESSION_MAX_AGE_SECONDS)}`;
  ids.memberCookie = `${SESSION_COOKIE_NAME}=${createSessionToken({ kind: 'person', personId: ids.member, sessionVersion: getSessionVersion(ids.member)! } as never, PERSON_SESSION_MAX_AGE_SECONDS)}`;
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('POST /api/periods/[id]/reset-roster', () => {
  it("removes the solver's shifts, keeps the hand-filled one and goes back to GESLOTEN", async () => {
    const id = period('GEGENEREERD');
    const before = periodRow(id).row_version;
    setPendingUndo({ scope: 'PERIOD_ASSIGNMENT', scopeId: id, actionType: 'REMOVE', payload: {}, label: 'x', actorId: ids.planner });

    const res = await call(id);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ status: 'GESLOTEN', verwijderd: 2, handmatig_verwijderd: 0 });
    expect(assignments(id)).toEqual(['MANUAL']);
    expect(periodRow(id)).toEqual({ status: 'GESLOTEN', row_version: before + 1 });
    expect(getPendingUndo(id)).toBeUndefined();
    const audit = db
      .prepare(`SELECT actie, nieuw_json FROM dienstrooster_audit_log WHERE entiteit_id = ? AND nieuw_json LIKE '%rooster verwijderd%'`)
      .all(id) as Array<{ actie: string; nieuw_json: string }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].nieuw_json)).toMatchObject({ solver_diensten_verwijderd: 2, handmatige_diensten_verwijderd: 0 });
  });

  it('removes the hand-filled shifts too when asked: a clean start', async () => {
    const id = period('GEGENEREERD');
    const res = await call(id, { ook_handmatig: true });
    expect((await res.json()).data).toEqual({ status: 'GESLOTEN', verwijderd: 3, handmatig_verwijderd: 1 });
    expect(assignments(id)).toEqual([]);
  });

  it('refuses a published roster: participants have seen it, withdraw it first', async () => {
    const id = period('GEPUBLICEERD');
    const res = await call(id, { ook_handmatig: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe('Trek eerst de publicatie in. Daarna kun je het rooster verwijderen.');
    expect(assignments(id)).toHaveLength(3);
    expect(periodRow(id).status).toBe('GEPUBLICEERD');
  });

  it('refuses a period without a generated roster, leaving its hand-filled shifts alone', async () => {
    for (const status of ['OPEN', 'GESLOTEN']) {
      const id = period(status);
      const res = await call(id, { ook_handmatig: true });
      expect(res.status, status).toBe(409);
      expect(assignments(id), status).toHaveLength(3);
      expect(periodRow(id).status).toBe(status);
    }
  });

  it('answers 400 to a choice that is not yes or no, and leaves the roster', async () => {
    const id = period('GEGENEREERD');
    for (const ook_handmatig of ['ja', 1, {}, []]) {
      expect((await call(id, { ook_handmatig })).status, JSON.stringify(ook_handmatig)).toBe(400);
    }
    expect(assignments(id)).toHaveLength(3);
  });

  it('is for planners only', async () => {
    const id = period('GEGENEREERD');
    expect([401, 403]).toContain((await call(id, {}, ids.memberCookie)).status);
    expect([401, 403]).toContain((await call(id, {}, '')).status);
    expect(assignments(id)).toHaveLength(3);
  });
});
