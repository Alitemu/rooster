import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import { checkBlockBudget } from '@/lib/blockBudget';

/**
 * Block budget: a period-level cap on how many slots of one counter a
 * single person may mark ABSOLUUT (blockBudget) or LIEVER_NIET
 * (softBlockBudget), as a fraction of that counter's total slots.
 */

interface Fixture {
  poolId: string;
  rulesetId: string;
  personId: string;
  periodId: string;
  slotIds: string[];
}

function createFixture(days: number, rulesetConfig: Record<string, unknown> = {}): Fixture {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Test ruleset', '{}');

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Test pool', rulesetId);

  const shiftTypeId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`
  ).run(shiftTypeId, poolId);

  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`);
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
  ).run(crypto.randomUUID(), personId, poolId);

  const startDate = '2027-01-04';
  const endDate = new Date(new Date(startDate).getTime() + (days - 1) * 86400000)
    .toISOString()
    .slice(0, 10);

  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'Test period', ?, ?, '2099-01-01T00:00:00Z', 'OPEN', ?, datetime('now'))`
  ).run(periodId, poolId, startDate, endDate, JSON.stringify(rulesetConfig));

  const slots = generateSlotsForPeriod({ startDate, endDate, shiftTypes: ['AVOND'] });
  const insertStmt = db.prepare(
    `INSERT INTO dienstrooster_shift_slot
       (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id,
        is_feestdag, feestdag_groep, benodigd_aantal_personen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  const slotIds: string[] = [];
  for (const slot of slots) {
    const id = crypto.randomUUID();
    insertStmt.run(
      id, periodId, shiftTypeId, slot.datum, slot.iso_jaar, slot.iso_week,
      slot.weekend_id || null, slot.is_feestdag ? 1 : 0, slot.feestdag_groep
    );
    slotIds.push(id);
  }

  return trackFixture({ poolId, rulesetId, personId, periodId, slotIds });
}

function block(personId: string, slotId: string, level: 'ABSOLUUT' | 'LIEVER_NIET', source: 'MANUAL' | 'PARTTIME' = 'MANUAL') {
  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId, level, source);
}

const createdPeriodIds: string[] = [];
function trackFixture(f: Fixture): Fixture {
  createdPeriodIds.push(f.periodId);
  return f;
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    const period = db
      .prepare('SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { pool_id: string } | undefined;
    if (!period) continue;

    db.prepare(
      `DELETE FROM dienstrooster_availability WHERE slot_id IN
       (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)`
    ).run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
    const memberIds = db
      .prepare('SELECT person_id FROM dienstrooster_pool_membership WHERE pool_id = ?')
      .all(period.pool_id) as Array<{ person_id: string }>;
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(period.pool_id);
    for (const m of memberIds) {
      db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(m.person_id);
    }
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(period.pool_id);
    const pool = db
      .prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?')
      .get(period.pool_id) as { ruleset_id: string } | undefined;
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(period.pool_id);
    if (pool) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
});

describe('checkBlockBudget', () => {
  it('allows anything when no blockBudget/softBlockBudget is configured', () => {
    const f = createFixture(14);
    for (let i = 0; i < f.slotIds.length - 1; i++) {
      block(f.personId, f.slotIds[i], 'ABSOLUUT');
    }
    const result = checkBlockBudget({
      period: { bevroren_ruleset_json: null, pool_id: f.poolId },
      periodId: f.periodId,
      personId: f.personId,
      teller: 'AVOND',
      level: 'ABSOLUUT',
      excludeSlotId: f.slotIds[f.slotIds.length - 1],
    });
    expect(result.allowed).toBe(true);
  });

  it('allows anything when maxFraction is 1 (no effective limit)', () => {
    const config = {
      blockBudget: {
        AVOND: { maxFraction: 1 },
        WEEKEND: { maxFraction: 1 },
        FEESTDAG: { maxFraction: 1 },
        parttimeExempt: true,
      },
    };
    const f = createFixture(14, config);
    for (let i = 0; i < f.slotIds.length - 1; i++) {
      block(f.personId, f.slotIds[i], 'ABSOLUUT');
    }
    const result = checkBlockBudget({
      period: { bevroren_ruleset_json: JSON.stringify(config), pool_id: f.poolId },
      periodId: f.periodId,
      personId: f.personId,
      teller: 'AVOND',
      level: 'ABSOLUUT',
      excludeSlotId: f.slotIds[f.slotIds.length - 1],
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects once the hard blockBudget fraction would be exceeded', () => {
    // 14 AVOND slots, maxFraction 0.2 -> floor(14*0.2) = 2 allowed
    const f = createFixture(14, {
      blockBudget: {
        AVOND: { maxFraction: 0.2 },
        WEEKEND: { maxFraction: 1 },
        FEESTDAG: { maxFraction: 1 },
        parttimeExempt: true,
      },
    });
    const period = { bevroren_ruleset_json: JSON.stringify({ blockBudget: { AVOND: { maxFraction: 0.2 }, WEEKEND: { maxFraction: 1 }, FEESTDAG: { maxFraction: 1 }, parttimeExempt: true } }), pool_id: f.poolId };

    // First block: 0 existing -> allowed (0 + 1 <= 2)
    expect(
      checkBlockBudget({ period, periodId: f.periodId, personId: f.personId, teller: 'AVOND', level: 'ABSOLUUT', excludeSlotId: f.slotIds[0] })
        .allowed
    ).toBe(true);
    block(f.personId, f.slotIds[0], 'ABSOLUUT');

    // Second block: 1 existing -> allowed (1 + 1 <= 2)
    expect(
      checkBlockBudget({ period, periodId: f.periodId, personId: f.personId, teller: 'AVOND', level: 'ABSOLUUT', excludeSlotId: f.slotIds[1] })
        .allowed
    ).toBe(true);
    block(f.personId, f.slotIds[1], 'ABSOLUUT');

    // Third block: 2 existing -> rejected (2 + 1 > 2)
    const third = checkBlockBudget({
      period, periodId: f.periodId, personId: f.personId, teller: 'AVOND', level: 'ABSOLUUT', excludeSlotId: f.slotIds[2],
    });
    expect(third.allowed).toBe(false);
    expect(third.message).toMatch(/maximum van 2/);
  });

  it('never blocks re-saving the same level on the slot itself (excludeSlotId)', () => {
    const f = createFixture(2, {
      blockBudget: { AVOND: { maxFraction: 0.5 }, WEEKEND: { maxFraction: 1 }, FEESTDAG: { maxFraction: 1 }, parttimeExempt: true },
    });
    const period = { bevroren_ruleset_json: JSON.stringify({ blockBudget: { AVOND: { maxFraction: 0.5 }, WEEKEND: { maxFraction: 1 }, FEESTDAG: { maxFraction: 1 }, parttimeExempt: true } }), pool_id: f.poolId };
    // 2 slots, maxFraction 0.5 -> maxAllowed = 1
    block(f.personId, f.slotIds[0], 'ABSOLUUT');

    const result = checkBlockBudget({
      period, periodId: f.periodId, personId: f.personId, teller: 'AVOND', level: 'ABSOLUUT', excludeSlotId: f.slotIds[0],
    });
    expect(result.allowed).toBe(true);
  });

  it('tracks ABSOLUUT and LIEVER_NIET budgets independently', () => {
    const f = createFixture(4, {
      blockBudget: { AVOND: { maxFraction: 0.25 }, WEEKEND: { maxFraction: 1 }, FEESTDAG: { maxFraction: 1 }, parttimeExempt: true },
      softBlockBudget: { AVOND: { maxFraction: 0.75 }, WEEKEND: { maxFraction: 1 }, FEESTDAG: { maxFraction: 1 } },
    });
    const period = {
      bevroren_ruleset_json: JSON.stringify({
        blockBudget: { AVOND: { maxFraction: 0.25 }, WEEKEND: { maxFraction: 1 }, FEESTDAG: { maxFraction: 1 }, parttimeExempt: true },
        softBlockBudget: { AVOND: { maxFraction: 0.75 }, WEEKEND: { maxFraction: 1 }, FEESTDAG: { maxFraction: 1 } },
      }),
      pool_id: f.poolId,
    };
    // 4 slots: ABSOLUUT max = floor(4*0.25) = 1, LIEVER_NIET max = floor(4*0.75) = 3
    block(f.personId, f.slotIds[0], 'ABSOLUUT');

    // A 2nd ABSOLUUT is now over budget...
    expect(
      checkBlockBudget({ period, periodId: f.periodId, personId: f.personId, teller: 'AVOND', level: 'ABSOLUUT', excludeSlotId: f.slotIds[1] })
        .allowed
    ).toBe(false);

    // ...but LIEVER_NIET on the same person/counter is untouched by that ABSOLUUT block
    expect(
      checkBlockBudget({ period, periodId: f.periodId, personId: f.personId, teller: 'AVOND', level: 'LIEVER_NIET', excludeSlotId: f.slotIds[1] })
        .allowed
    ).toBe(true);
  });

  it('excludes PARTTIME-sourced blocks from the count when parttimeExempt is true', () => {
    const f = createFixture(4, {
      blockBudget: { AVOND: { maxFraction: 0.25 }, WEEKEND: { maxFraction: 1 }, FEESTDAG: { maxFraction: 1 }, parttimeExempt: true },
    });
    const period = {
      bevroren_ruleset_json: JSON.stringify({
        blockBudget: { AVOND: { maxFraction: 0.25 }, WEEKEND: { maxFraction: 1 }, FEESTDAG: { maxFraction: 1 }, parttimeExempt: true },
      }),
      pool_id: f.poolId,
    };
    // 4 slots, maxFraction 0.25 -> maxAllowed = 1. Two PARTTIME-sourced
    // blocks already exist but don't count toward the exempt budget.
    block(f.personId, f.slotIds[0], 'ABSOLUUT', 'PARTTIME');
    block(f.personId, f.slotIds[1], 'ABSOLUUT', 'PARTTIME');

    const result = checkBlockBudget({
      period, periodId: f.periodId, personId: f.personId, teller: 'AVOND', level: 'ABSOLUUT', excludeSlotId: f.slotIds[2],
    });
    expect(result.allowed).toBe(true);
  });

  it('counts PARTTIME-sourced blocks when parttimeExempt is false', () => {
    const f = createFixture(4, {
      blockBudget: { AVOND: { maxFraction: 0.25 }, WEEKEND: { maxFraction: 1 }, FEESTDAG: { maxFraction: 1 }, parttimeExempt: false },
    });
    const period = {
      bevroren_ruleset_json: JSON.stringify({
        blockBudget: { AVOND: { maxFraction: 0.25 }, WEEKEND: { maxFraction: 1 }, FEESTDAG: { maxFraction: 1 }, parttimeExempt: false },
      }),
      pool_id: f.poolId,
    };
    block(f.personId, f.slotIds[0], 'ABSOLUUT', 'PARTTIME');

    const result = checkBlockBudget({
      period, periodId: f.periodId, personId: f.personId, teller: 'AVOND', level: 'ABSOLUUT', excludeSlotId: f.slotIds[1],
    });
    expect(result.allowed).toBe(false);
  });
});
