import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import { computeCarryOver, applyCarryOverForPeriod, findPreviousPublishedPeriod } from '@/lib/carryOver';

/**
 * Carry-over between periods.
 *
 * The rule that must not break: someone who worked below target in a
 * published period gets a *positive* delta in the next one, because the
 * solver applies delta as `band + delta` (db/schema.ts: positive = more
 * shifts). Getting that sign backwards would quietly punish the person who
 * was already short-changed, and nothing else in the system would notice.
 */

interface Ctx {
  poolId: string;
  shiftTypeId: string;
  personIds: string[];
}

const createdPeriodIds: string[] = [];
const createdPoolIds: string[] = [];

function createPool(personCount: number, band: [number, number]): Ctx {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Test ruleset', JSON.stringify({ bandAvond: band }));

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Test pool', rulesetId);
  createdPoolIds.push(poolId);

  const shiftTypeId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`
  ).run(shiftTypeId, poolId);

  const personIds: string[] = [];
  for (let i = 0; i < personCount; i++) {
    const personId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', datetime('now'))`
    ).run(personId, `Test-${personId.slice(0, 8)}`);
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
    ).run(crypto.randomUUID(), personId, poolId);
    personIds.push(personId);
  }

  return { poolId, shiftTypeId, personIds };
}

function createPeriod(
  ctx: Ctx,
  startDate: string,
  endDate: string,
  status: string,
  band: [number, number]
): { periodId: string; slotIds: string[] } {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'P', ?, ?, '2099-01-01T00:00:00Z', ?, ?, datetime('now'))`
  ).run(periodId, ctx.poolId, startDate, endDate, status, JSON.stringify({ bandAvond: band }));
  createdPeriodIds.push(periodId);

  const slots = generateSlotsForPeriod({ startDate, endDate, shiftTypes: ['AVOND'] });
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

function assign(periodId: string, personId: string, slotId: string) {
  db.prepare(
    `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
  ).run(crypto.randomUUID(), periodId, personId, slotId);
}

function ledgerFor(periodId: string, personId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(delta), 0) as total FROM dienstrooster_ledger_entry
       WHERE geldt_voor_periode_id = ? AND person_id = ? AND teller = 'AVOND'`
    )
    .get(periodId, personId) as { total: number };
  return row.total;
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  while (createdPoolIds.length > 0) {
    const poolId = createdPoolIds.pop()!;
    const members = db
      .prepare('SELECT person_id FROM dienstrooster_pool_membership WHERE pool_id = ?')
      .all(poolId) as Array<{ person_id: string }>;
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    for (const m of members) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(m.person_id);
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as
      | { ruleset_id: string }
      | undefined;
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
});

describe('carryOver', () => {
  it('gives someone who worked BELOW target a positive delta (they make it up)', () => {
    const ctx = createPool(2, [4, 4]); // target 4
    const prev = createPeriod(ctx, '2027-01-04', '2027-01-31', 'GEPUBLICEERD', [4, 4]);
    // person 0 works only 2 of their 4
    assign(prev.periodId, ctx.personIds[0], prev.slotIds[0]);
    assign(prev.periodId, ctx.personIds[0], prev.slotIds[1]);

    const entries = computeCarryOver(
      db.prepare('SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?').get(prev.periodId) as any
    );

    const own = entries.find((e) => e.person_id === ctx.personIds[0] && e.teller === 'AVOND');
    expect(own).toBeDefined();
    expect(own!.delta).toBe(2);
    expect(own!.delta).toBeGreaterThan(0);
  });

  it('gives someone who worked ABOVE target a negative delta (they do less next time)', () => {
    const ctx = createPool(2, [2, 2]); // target 2
    const prev = createPeriod(ctx, '2027-01-04', '2027-01-31', 'GEPUBLICEERD', [2, 2]);
    for (let i = 0; i < 5; i++) assign(prev.periodId, ctx.personIds[0], prev.slotIds[i]);

    const entries = computeCarryOver(
      db.prepare('SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?').get(prev.periodId) as any
    );

    const own = entries.find((e) => e.person_id === ctx.personIds[0])!;
    expect(own.delta).toBe(-3);
  });

  it('records nothing for anyone who landed anywhere inside their band', () => {
    // The band is the promise, so 5 and 6 are both "kept" for a [5,6] band.
    // Measuring against the midpoint instead would bank -1 on everyone who
    // worked 6, and that debt compounds downward every period.
    const ctx = createPool(2, [5, 6]);
    const prev = createPeriod(ctx, '2027-01-04', '2027-02-28', 'GEPUBLICEERD', [5, 6]);
    for (let i = 0; i < 5; i++) assign(prev.periodId, ctx.personIds[0], prev.slotIds[i]);
    for (let i = 5; i < 11; i++) assign(prev.periodId, ctx.personIds[1], prev.slotIds[i]);

    const entries = computeCarryOver(
      db.prepare('SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?').get(prev.periodId) as any
    );

    expect(entries.filter((e) => e.teller === 'AVOND')).toEqual([]);
  });

  it('records nothing for someone who hit their target exactly', () => {
    const ctx = createPool(1, [3, 3]);
    const prev = createPeriod(ctx, '2027-01-04', '2027-01-31', 'GEPUBLICEERD', [3, 3]);
    for (let i = 0; i < 3; i++) assign(prev.periodId, ctx.personIds[0], prev.slotIds[i]);

    const entries = computeCarryOver(
      db.prepare('SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?').get(prev.periodId) as any
    );

    expect(entries.find((e) => e.person_id === ctx.personIds[0])).toBeUndefined();
  });

  it('books the carry-over against the NEW period, not the old one', () => {
    const ctx = createPool(1, [3, 3]);
    const prev = createPeriod(ctx, '2027-01-04', '2027-01-31', 'GEPUBLICEERD', [3, 3]);
    assign(prev.periodId, ctx.personIds[0], prev.slotIds[0]); // 1 of 3
    const next = createPeriod(ctx, '2027-02-01', '2027-02-28', 'CONCEPT', [3, 3]);

    const written = applyCarryOverForPeriod(next.periodId, ctx.personIds[0]);

    expect(written).toBeGreaterThan(0);
    expect(ledgerFor(next.periodId, ctx.personIds[0])).toBe(2);
    expect(ledgerFor(prev.periodId, ctx.personIds[0])).toBe(0);
  });

  it('is idempotent - re-opening a period does not stack a second carry-over', () => {
    const ctx = createPool(1, [3, 3]);
    const prev = createPeriod(ctx, '2027-01-04', '2027-01-31', 'GEPUBLICEERD', [3, 3]);
    assign(prev.periodId, ctx.personIds[0], prev.slotIds[0]);
    const next = createPeriod(ctx, '2027-02-01', '2027-02-28', 'CONCEPT', [3, 3]);

    applyCarryOverForPeriod(next.periodId, ctx.personIds[0]);
    applyCarryOverForPeriod(next.periodId, ctx.personIds[0]);
    applyCarryOverForPeriod(next.periodId, ctx.personIds[0]);

    expect(ledgerFor(next.periodId, ctx.personIds[0])).toBe(2);
  });

  it('leaves the planner\'s own BEGINSALDO bookings alone', () => {
    const ctx = createPool(1, [3, 3]);
    const prev = createPeriod(ctx, '2027-01-04', '2027-01-31', 'GEPUBLICEERD', [3, 3]);
    assign(prev.periodId, ctx.personIds[0], prev.slotIds[0]);
    const next = createPeriod(ctx, '2027-02-01', '2027-02-28', 'CONCEPT', [3, 3]);

    db.prepare(
      `INSERT INTO dienstrooster_ledger_entry
         (id, person_id, pool_id, teller, geldt_voor_periode_id, delta, reden, categorie, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, 'AVOND', ?, 5, 'manual opening balance', 'BEGINSALDO', ?, datetime('now'))`
    ).run(crypto.randomUUID(), ctx.personIds[0], ctx.poolId, next.periodId, ctx.personIds[0]);

    applyCarryOverForPeriod(next.periodId, ctx.personIds[0]);
    applyCarryOverForPeriod(next.periodId, ctx.personIds[0]);

    // 5 (untouched beginsaldo) + 2 (carry-over, written once)
    expect(ledgerFor(next.periodId, ctx.personIds[0])).toBe(7);
  });

  it('compounds a debt that was still not met', () => {
    const ctx = createPool(1, [3, 3]);
    // Period 1 already carried +2 into it, so the person owed 3 + 2 = 5,
    // but only worked 1 - leaving 4 still outstanding.
    const p1 = createPeriod(ctx, '2027-01-04', '2027-01-31', 'GEPUBLICEERD', [3, 3]);
    db.prepare(
      `INSERT INTO dienstrooster_ledger_entry
         (id, person_id, pool_id, teller, geldt_voor_periode_id, delta, reden, categorie, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, 'AVOND', ?, 2, 'earlier carry-over', 'CARRY_OVER', ?, datetime('now'))`
    ).run(crypto.randomUUID(), ctx.personIds[0], ctx.poolId, p1.periodId, ctx.personIds[0]);
    assign(p1.periodId, ctx.personIds[0], p1.slotIds[0]);

    const p2 = createPeriod(ctx, '2027-02-01', '2027-02-28', 'CONCEPT', [3, 3]);
    applyCarryOverForPeriod(p2.periodId, ctx.personIds[0]);

    expect(ledgerFor(p2.periodId, ctx.personIds[0])).toBe(4);
  });

  it('carries nothing for a pool\'s first-ever period', () => {
    const ctx = createPool(1, [3, 3]);
    const first = createPeriod(ctx, '2027-01-04', '2027-01-31', 'CONCEPT', [3, 3]);

    expect(findPreviousPublishedPeriod(ctx.poolId, '2027-01-04')).toBeUndefined();
    expect(applyCarryOverForPeriod(first.periodId, ctx.personIds[0])).toBe(0);
  });

  it('ignores an unpublished previous period', () => {
    const ctx = createPool(1, [3, 3]);
    createPeriod(ctx, '2027-01-04', '2027-01-31', 'GEGENEREERD', [3, 3]); // not published
    const next = createPeriod(ctx, '2027-02-01', '2027-02-28', 'CONCEPT', [3, 3]);

    expect(applyCarryOverForPeriod(next.periodId, ctx.personIds[0])).toBe(0);
  });
});
