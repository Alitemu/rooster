import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST } from './route';

/**
 * The hard rule this route enforces, in three parts:
 *
 *   1. A genuine issue (an unfilled slot, a band violation) always blocks
 *      publishing, confirmOverrides or not.
 *   2. A warning (a deliberate ABSOLUUT/window-rule override a planner
 *      already made via manual-assign) stops publish once, asking for
 *      confirmOverrides, rather than shipping silently.
 *   3. With confirmOverrides: true, that same roster does publish, and the
 *      audit trail records which warnings were confirmed.
 *
 * This is the fix for the contradiction the audit found: manual-assign
 * explicitly allows overriding an ABSOLUUT block "in consultation with the
 * person taking the shift", but publish used to refuse outright the moment
 * that override existed - there was no way to ever ship a roster that used
 * it.
 */

const createdPeriodIds: string[] = [];
const createdPoolIds: string[] = [];

function createPool(personCount: number): { poolId: string; shiftTypeId: string; personIds: string[] } {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Publish test', '{}');

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Publish test pool', rulesetId);
  createdPoolIds.push(poolId);

  const shiftTypeId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`
  ).run(shiftTypeId, poolId);

  const personIds: string[] = [];
  for (let i = 0; i < personCount; i++) {
    const personId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op)
       VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
    ).run(personId, `Test-${personId.slice(0, 8)}`);
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
    ).run(crypto.randomUUID(), personId, poolId);
    personIds.push(personId);
  }

  return { poolId, shiftTypeId, personIds };
}

function createPlanner(): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op)
     VALUES (?, ?, 'PLANNER', 1, datetime('now'))`
  ).run(personId, `Planner-${personId.slice(0, 8)}`);
  return personId;
}

// 7 AVOND slots, one person, all 7 go to that one person - band [7,7] so it
// always passes band_compliance/slots_filled and only what a test adds
// on top (a block, nothing) decides the outcome.
const START = '2027-01-04';
const END = '2027-01-10';

function createPeriod(ctx: { poolId: string; shiftTypeId: string }, frozen: Record<string, unknown>) {
  const periodId = crypto.randomUUID();
  // windowWeeks: 1 ("no window rule") unless a test overrides it - every
  // AVOND shift going to one person here means they'd otherwise have
  // several shifts in the very same ISO week, which the window rule
  // genuinely does forbid once windowWeeks >= 2. None of the tests below
  // are about that rule; see lib/publicationCheck.test.ts's createPeriod
  // for the identical reasoning.
  const rulesetConfig = { windowWeeks: 1, ...frozen };
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'P', ?, ?, '2099-01-01T00:00:00Z', 'GEGENEREERD', ?, datetime('now'))`
  ).run(periodId, ctx.poolId, START, END, JSON.stringify(rulesetConfig));
  createdPeriodIds.push(periodId);

  const slots = generateSlotsForPeriod({ startDate: START, endDate: END, shiftTypes: ['AVOND'] });
  const insert = db.prepare(
    `INSERT INTO dienstrooster_shift_slot
       (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id, is_feestdag, feestdag_groep, benodigd_aantal_personen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  const slotIds: string[] = [];
  for (const s of slots) {
    const id = crypto.randomUUID();
    insert.run(id, periodId, ctx.shiftTypeId, s.datum, s.iso_jaar, s.iso_week, s.weekend_id || null, s.is_feestdag ? 1 : 0, s.feestdag_groep);
    slotIds.push(id);
  }
  return { periodId, slotIds };
}

function fillAllWith(periodId: string, personId: string, slotIds: string[]) {
  const insert = db.prepare(
    `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
  );
  for (const slotId of slotIds) insert.run(crypto.randomUUID(), periodId, personId, slotId);
}

function block(personId: string, slotId: string) {
  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
     VALUES (?, ?, ?, 'ABSOLUUT', 'MANUAL', datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId);
}

function post(periodId: string, plannerId: string, body?: Record<string, unknown>) {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return POST(
    new NextRequest(`http://localhost/api/planner/period/${periodId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      body: JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve({ id: periodId }) }
  );
}

function periodStatus(periodId: string): string {
  return (db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as { status: string }).status;
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_notification WHERE periode_id = ?').run(periodId);
    db.prepare(
      'DELETE FROM dienstrooster_availability WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)'
    ).run(periodId);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  while (createdPoolIds.length > 0) {
    const poolId = createdPoolIds.pop()!;
    const members = db.prepare('SELECT person_id FROM dienstrooster_pool_membership WHERE pool_id = ?').all(poolId) as Array<{ person_id: string }>;
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    for (const m of members) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(m.person_id);
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as { ruleset_id: string } | undefined;
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
});

describe('POST /api/planner/period/[id]/publish', () => {
  it('publishes a clean roster without needing confirmOverrides at all', async () => {
    const ctx = createPool(1);
    const planner = createPlanner();
    const { periodId, slotIds } = createPeriod(ctx, { bandAvond: [7, 7] });
    fillAllWith(periodId, ctx.personIds[0], slotIds);

    const res = await post(periodId, planner);
    expect(res.status).toBe(200);
    expect(periodStatus(periodId)).toBe('GEPUBLICEERD');
  });

  it('always blocks on a genuine issue, confirmOverrides or not', async () => {
    const ctx = createPool(1);
    const planner = createPlanner();
    const { periodId, slotIds } = createPeriod(ctx, { bandAvond: [7, 7] });
    fillAllWith(periodId, ctx.personIds[0], slotIds.slice(0, -1)); // one short

    const res = await post(periodId, planner, { confirmOverrides: true });
    expect(res.status).toBe(400);
    expect(periodStatus(periodId)).toBe('GEGENEREERD');
  });

  it('stops once for a deliberate ABSOLUUT override, asking for confirmation', async () => {
    const ctx = createPool(1);
    const planner = createPlanner();
    const { periodId, slotIds } = createPeriod(ctx, { bandAvond: [7, 7] });
    fillAllWith(periodId, ctx.personIds[0], slotIds);
    block(ctx.personIds[0], slotIds[0]);

    const res = await post(periodId, planner);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(body.data.warnings.join(' ')).toContain('geblokkeerd');
    // Not published: this was a stop for confirmation, not a rejection
    // that leaves the roster stuck - the very next call with
    // confirmOverrides succeeds.
    expect(periodStatus(periodId)).toBe('GEGENEREERD');
  });

  it('publishes the same override once confirmOverrides is true', async () => {
    const ctx = createPool(1);
    const planner = createPlanner();
    const { periodId, slotIds } = createPeriod(ctx, { bandAvond: [7, 7] });
    fillAllWith(periodId, ctx.personIds[0], slotIds);
    block(ctx.personIds[0], slotIds[0]);

    const res = await post(periodId, planner, { confirmOverrides: true });
    expect(res.status).toBe(200);
    expect(periodStatus(periodId)).toBe('GEPUBLICEERD');
  });

  it('records which warnings were confirmed in the audit trail', async () => {
    const ctx = createPool(1);
    const planner = createPlanner();
    const { periodId, slotIds } = createPeriod(ctx, { bandAvond: [7, 7] });
    fillAllWith(periodId, ctx.personIds[0], slotIds);
    block(ctx.personIds[0], slotIds[0]);

    await post(periodId, planner, { confirmOverrides: true });

    const entry = db
      .prepare(`SELECT nieuw_json FROM dienstrooster_audit_log WHERE entiteit_id = ? AND actie = 'PUBLISH'`)
      .get(periodId) as { nieuw_json: string };
    const parsed = JSON.parse(entry.nieuw_json);
    expect(parsed.overrides_confirmed).toBeDefined();
    expect(parsed.overrides_confirmed.join(' ')).toContain('geblokkeerd');
  });

  it('does not add an overrides_confirmed field when there was nothing to confirm', async () => {
    const ctx = createPool(1);
    const planner = createPlanner();
    const { periodId, slotIds } = createPeriod(ctx, { bandAvond: [7, 7] });
    fillAllWith(periodId, ctx.personIds[0], slotIds);

    await post(periodId, planner);

    const entry = db
      .prepare(`SELECT nieuw_json FROM dienstrooster_audit_log WHERE entiteit_id = ? AND actie = 'PUBLISH'`)
      .get(periodId) as { nieuw_json: string };
    expect(JSON.parse(entry.nieuw_json).overrides_confirmed).toBeUndefined();
  });
});
