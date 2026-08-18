import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import { runPublicationCheck } from '@/lib/publicationCheck';

/**
 * The publication gate.
 *
 * Publishing freezes the period and tells every pool member these are their
 * shifts, so this is the last point at which a broken roster can be stopped.
 * It has to actually stop one: a direct POST to /publish used to bypass the
 * dialog entirely and published a roster with zero assignments.
 *
 * Each test below constructs a roster that violates exactly one rule and
 * proves the gate refuses it - not that it accepts a good one.
 */

interface Ctx {
  poolId: string;
  shiftTypeId: string;
  personIds: string[];
}

const createdPeriodIds: string[] = [];
const createdPoolIds: string[] = [];

function createPool(personCount: number, config: Record<string, unknown>): Ctx {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Test ruleset', JSON.stringify(config));

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

interface Period {
  id: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
  bevroren_ruleset_json: string | null;
}

function createPeriod(
  ctx: Ctx,
  startDate: string,
  endDate: string,
  frozen: Record<string, unknown> | null
): { period: Period; slotIds: string[] } {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'P', ?, ?, '2099-01-01T00:00:00Z', 'GEGENEREERD', ?, datetime('now'))`
  ).run(periodId, ctx.poolId, startDate, endDate, frozen ? JSON.stringify(frozen) : null);
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
    insert.run(
      id,
      periodId,
      ctx.shiftTypeId,
      s.datum,
      s.iso_jaar,
      s.iso_week,
      s.weekend_id || null,
      s.is_feestdag ? 1 : 0,
      s.feestdag_groep
    );
    slotIds.push(id);
  }

  const period = db
    .prepare(
      'SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?'
    )
    .get(periodId) as Period;

  return { period, slotIds };
}

function assign(periodId: string, personId: string, slotId: string, bron = 'SOLVER') {
  db.prepare(
    `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`
  ).run(crypto.randomUUID(), periodId, personId, slotId, bron);
}

/** A carry-over from a previous period, which shifts this person's band. */
function ledger(poolId: string, personId: string, periodId: string, delta: number) {
  db.prepare(
    `INSERT INTO dienstrooster_ledger_entry
       (id, pool_id, person_id, teller, delta, categorie, reden, geldt_voor_periode_id,
        aangemaakt_door, aangemaakt_op)
     VALUES (?, ?, ?, 'AVOND', ?, 'CARRY_OVER', 'test', ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), poolId, personId, delta, periodId, personId);
}

function block(personId: string, slotId: string, level: 'ABSOLUUT' | 'LIEVER_NIET') {
  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'MANUAL', datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId, level);
}

/**
 * Fill every slot while keeping each person inside [min, max] for AVOND.
 * Round-robin over `people` so the counts stay as even as the slot count allows.
 */
function fillEvenly(periodId: string, slotIds: string[], personIds: string[]) {
  slotIds.forEach((slotId, i) => assign(periodId, personIds[i % personIds.length], slotId));
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare(
      `DELETE FROM dienstrooster_availability WHERE slot_id IN
         (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)`
    ).run(periodId);
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

describe('runPublicationCheck', () => {
  // 28 days -> 28 AVOND slots, 7 people -> exactly 4 each.
  const START = '2027-01-04';
  const END = '2027-01-31';

  it('passes a roster that is complete, unblocked and inside the band', () => {
    const ctx = createPool(7, { bandAvond: [4, 4] });
    const { period, slotIds } = createPeriod(ctx, START, END, { bandAvond: [4, 4] });
    fillEvenly(period.id, slotIds, ctx.personIds);

    const result = runPublicationCheck(period);

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.totals.assigned_slots).toBe(slotIds.length);
    expect(result.totals.people_affected).toBe(7);
  });

  it('refuses a roster with zero assignments', () => {
    // The exact case that got past the API before: publish was called
    // directly and notified every pool member about an empty roster.
    const ctx = createPool(7, { bandAvond: [4, 4] });
    const { period, slotIds } = createPeriod(ctx, START, END, { bandAvond: [4, 4] });

    const result = runPublicationCheck(period);

    expect(result.valid).toBe(false);
    expect(result.checks.slots_filled).toBe(false);
    expect(result.totals.assigned_slots).toBe(0);
    expect(result.issues.join(' ')).toContain(`0 van ${slotIds.length}`);
  });

  it('refuses a roster that is one slot short', () => {
    const ctx = createPool(7, { bandAvond: [0, 28] });
    const { period, slotIds } = createPeriod(ctx, START, END, { bandAvond: [0, 28] });
    fillEvenly(period.id, slotIds.slice(0, -1), ctx.personIds);

    const result = runPublicationCheck(period);

    expect(result.valid).toBe(false);
    expect(result.checks.slots_filled).toBe(false);
    expect(result.issues.join(' ')).toContain(`${slotIds.length - 1} van ${slotIds.length}`);
  });

  it('refuses a roster that schedules someone on a day they blocked absolutely', () => {
    const ctx = createPool(7, { bandAvond: [4, 4] });
    const { period, slotIds } = createPeriod(ctx, START, END, { bandAvond: [4, 4] });
    fillEvenly(period.id, slotIds, ctx.personIds);

    // slotIds[0] went to person 0 in the round robin.
    block(ctx.personIds[0], slotIds[0], 'ABSOLUUT');

    const result = runPublicationCheck(period);

    expect(result.valid).toBe(false);
    expect(result.checks.no_hard_blocking).toBe(false);
    expect(result.checks.slots_filled).toBe(true);
    // User-facing text says "geblokkeerd", not the internal ABSOLUUT enum
    // value (CLAUDE.md terminology: ABSOLUUT -> "Geblokkeerd" for users).
    expect(result.issues.join(' ')).toContain('geblokkeerd');
  });

  it('allows a soft "prefer not" day to be used', () => {
    // LIEVER_NIET is a preference the solver pays for, not a rule that
    // blocks publication. Treating it as hard would make most rosters
    // unpublishable.
    const ctx = createPool(7, { bandAvond: [4, 4] });
    const { period, slotIds } = createPeriod(ctx, START, END, { bandAvond: [4, 4] });
    fillEvenly(period.id, slotIds, ctx.personIds);
    block(ctx.personIds[0], slotIds[0], 'LIEVER_NIET');

    const result = runPublicationCheck(period);

    expect(result.checks.no_hard_blocking).toBe(true);
    expect(result.valid).toBe(true);
  });

  it('refuses a roster where one person is over the band by a single shift', () => {
    const ctx = createPool(7, { bandAvond: [4, 4] });
    const { period, slotIds } = createPeriod(ctx, START, END, { bandAvond: [4, 4] });

    // Person 0 takes 5, person 1 takes 3 - still 28 slots, still everyone
    // scheduled, but the distribution is unfair by exactly one shift.
    fillEvenly(period.id, slotIds, ctx.personIds);
    const slotOfPerson1 = slotIds[1];
    db.prepare(
      'UPDATE dienstrooster_assignment SET person_id = ? WHERE schedule_version_id = ? AND slot_id = ?'
    ).run(ctx.personIds[0], period.id, slotOfPerson1);

    const result = runPublicationCheck(period);

    expect(result.checks.slots_filled).toBe(true);
    expect(result.checks.band_compliance).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('counts a pool member with no assignments at all as a band violation', () => {
    // The regression this guards: counting only people who appear in the
    // assignment table means somebody scheduled zero times is invisible,
    // which is precisely what a band's lower bound exists to catch.
    const ctx = createPool(8, { bandAvond: [3, 4] });
    const { period, slotIds } = createPeriod(ctx, START, END, { bandAvond: [3, 4] });

    // Spread all 28 slots over 7 of the 8 people; the 8th gets nothing.
    fillEvenly(period.id, slotIds, ctx.personIds.slice(0, 7));

    const result = runPublicationCheck(period);

    expect(result.checks.slots_filled).toBe(true);
    expect(result.checks.band_compliance).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('uses the period frozen ruleset, not the pool current one', () => {
    // The pool's ruleset says [1, 2]; the period froze [4, 4] when it
    // opened. A roster of 4 each must pass, because retroactive rule
    // changes are exactly what freezing prevents.
    const ctx = createPool(7, { bandAvond: [1, 2] });
    const { period, slotIds } = createPeriod(ctx, START, END, { bandAvond: [4, 4] });
    fillEvenly(period.id, slotIds, ctx.personIds);

    const result = runPublicationCheck(period);

    expect(result.bands.AVOND).toEqual([4, 4]);
    expect(result.valid).toBe(true);
  });

  it('falls back to the pool ruleset when the period has no frozen copy', () => {
    const ctx = createPool(7, { bandAvond: [4, 4] });
    const { period, slotIds } = createPeriod(ctx, START, END, null);
    fillEvenly(period.id, slotIds, ctx.personIds);

    const result = runPublicationCheck(period);

    expect(result.bands.AVOND).toEqual([4, 4]);
    expect(result.valid).toBe(true);
  });

  it('shifts a person band by their ledger delta', () => {
    // Someone owed 1 extra shift from last period has a band of [5, 5]
    // this period, so 4 is now too few for them and 5 is correct.
    const ctx = createPool(7, { bandAvond: [4, 4] });
    const { period, slotIds } = createPeriod(ctx, START, END, { bandAvond: [4, 4] });
    fillEvenly(period.id, slotIds, ctx.personIds);

    ledger(ctx.poolId, ctx.personIds[0], period.id, 1);

    // Person 0 has 4, but their adjusted band is [5, 5].
    const withoutExtra = runPublicationCheck(period);
    expect(withoutExtra.checks.band_compliance).toBe(false);

    // Give person 0 a fifth shift by taking one from person 1, and give
    // person 1 a matching -1 so their band becomes [3, 3].
    db.prepare(
      'UPDATE dienstrooster_assignment SET person_id = ? WHERE schedule_version_id = ? AND slot_id = ?'
    ).run(ctx.personIds[0], period.id, slotIds[1]);
    ledger(ctx.poolId, ctx.personIds[1], period.id, -1);

    const withExtra = runPublicationCheck(period);
    expect(withExtra.checks.band_compliance).toBe(true);
    expect(withExtra.valid).toBe(true);
  });

  it('accepts a fully manual roster - the source of an assignment is irrelevant', () => {
    // Gaps the solver could not fill are filled by hand, so a published
    // roster may legitimately contain no SOLVER rows at all.
    const ctx = createPool(7, { bandAvond: [4, 4] });
    const { period, slotIds } = createPeriod(ctx, START, END, { bandAvond: [4, 4] });
    slotIds.forEach((slotId, i) =>
      assign(period.id, ctx.personIds[i % 7], slotId, 'MANUAL')
    );

    const result = runPublicationCheck(period);

    expect(result.valid).toBe(true);
  });

  it('reports every failing rule at once, not just the first', () => {
    const ctx = createPool(7, { bandAvond: [4, 4] });
    const { period, slotIds } = createPeriod(ctx, START, END, { bandAvond: [4, 4] });
    // Short by one slot AND a hard-block violation.
    fillEvenly(period.id, slotIds.slice(0, -1), ctx.personIds);
    block(ctx.personIds[0], slotIds[0], 'ABSOLUUT');

    const result = runPublicationCheck(period);

    expect(result.checks.slots_filled).toBe(false);
    expect(result.checks.no_hard_blocking).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});
