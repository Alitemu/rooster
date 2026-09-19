import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  PERSON_SESSION_MAX_AGE_SECONDS,
} from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { syncAvailabilityForPattern } from '@/lib/parttimeSync';
import { PATCH } from './route';

/**
 * The hard rule: a row this person set by hand is owned by them.
 *
 * A part-time pattern and an absence each create ABSOLUUT rows carrying
 * their own `source` and `bron_*` id, and both sync modules deliberately
 * never touch a slot another source owns. Saving a preference used to
 * update `blocking_level` alone, so a pattern-owned row kept its label
 * while holding a hand-picked level. Two things went wrong from there: the
 * pattern still believed it covered a free day whose ABSOLUUT had quietly
 * become a VOORKEUR, and the next pattern edit deleted the person's own
 * choice along with its own rows, because it removes them by
 * bron_pattern_id.
 */

const created = {
  periods: [] as string[],
  pools: [] as string[],
  rulesets: [] as string[],
  people: [] as string[],
  shiftTypes: [] as string[],
  patterns: [] as string[],
};

interface Fixture {
  personId: string;
  periodId: string;
  /** A Monday in the period, which the pattern below covers. */
  mondaySlotId: string;
  patternId: string;
}

function createFixture(): Fixture {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Slot test', JSON.stringify({ windowWeeks: 2 }));
  created.rulesets.push(rulesetId);

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, `Pool-${poolId.slice(0, 6)}`, rulesetId);
  created.pools.push(poolId);

  const shiftTypeId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`
  ).run(shiftTypeId, poolId);
  created.shiftTypes.push(shiftTypeId);

  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op)
     VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
  ).run(personId, `S-${personId.slice(0, 8)}`);
  created.people.push(personId);

  db.prepare(
    `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op)
     VALUES (?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, hashToken(`l-${crypto.randomUUID()}`));

  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, 1, '2000-01-01', '2100-01-01')`
  ).run(crypto.randomUUID(), personId, poolId);

  // OPEN with a deadline far away, so the period gate lets input through.
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'P', '2027-01-04', '2027-01-17', '2099-01-01T00:00:00Z', 'OPEN', datetime('now'))`
  ).run(periodId, poolId);
  created.periods.push(periodId);

  // 2027-01-04 and 2027-01-11 are both Mondays (ISO weeks 1 and 2).
  const slotIds: Record<string, string> = {};
  for (const [datum, isoWeek] of [
    ['2027-01-04', 1],
    ['2027-01-11', 2],
  ] as const) {
    const slotId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
       VALUES (?, ?, ?, ?, 2027, ?)`
    ).run(slotId, periodId, shiftTypeId, datum, isoWeek);
    slotIds[datum] = slotId;
  }

  const patternId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_parttime_pattern
       (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
     VALUES (?, ?, 'MA', 'ELKE_WEEK', '2000-01-01', '2100-01-01', ?, datetime('now'))`
  ).run(patternId, personId, personId);
  created.patterns.push(patternId);

  // Let the pattern claim both Mondays, exactly as the app does.
  syncAvailabilityForPattern(patternId);

  return { personId, periodId, mondaySlotId: slotIds['2027-01-04'], patternId };
}

function patch(personId: string, slotId: string, level: string | null) {
  const token = createSessionToken(
    { kind: 'person', personId, sessionVersion: getSessionVersion(personId)! } as never,
    PERSON_SESSION_MAX_AGE_SECONDS
  );
  return PATCH(
    new NextRequest(`http://localhost/api/person/${personId}/preferences/slot/${slotId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      body: JSON.stringify({ level }),
    }),
    { params: Promise.resolve({ id: personId, slotId }) }
  );
}

function row(personId: string, slotId: string) {
  return db
    .prepare(
      `SELECT blocking_level, source, bron_pattern_id, bron_absence_id
       FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?`
    )
    .get(personId, slotId) as
    | { blocking_level: string | null; source: string; bron_pattern_id: string | null; bron_absence_id: string | null }
    | undefined;
}

afterEach(() => {
  for (const periodId of created.periods) {
    db.prepare(
      'DELETE FROM dienstrooster_availability WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)'
    ).run(periodId);
    db.prepare('DELETE FROM dienstrooster_submission WHERE schedule_period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  for (const id of created.patterns) db.prepare('DELETE FROM dienstrooster_parttime_pattern WHERE id = ?').run(id);
  for (const id of created.shiftTypes) db.prepare('DELETE FROM dienstrooster_shift_type WHERE id = ?').run(id);
  for (const personId of created.people) {
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
  for (const id of created.pools) db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  for (const id of created.rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
  created.periods = [];
  created.patterns = [];
  created.shiftTypes = [];
  created.people = [];
  created.pools = [];
  created.rulesets = [];
});

describe('PATCH /api/person/[id]/preferences/slot/[slotId]', () => {
  it('sets a preference on an untouched slot', async () => {
    const f = createFixture();
    const free = db
      .prepare(`SELECT id FROM dienstrooster_shift_slot WHERE period_id = ? AND datum = '2027-01-11'`)
      .get(f.periodId) as { id: string };

    const res = await patch(f.personId, free.id, 'VOORKEUR');
    expect(res.status).toBe(200);
    expect(row(f.personId, free.id)).toMatchObject({
      blocking_level: 'VOORKEUR',
      source: 'MANUAL',
      bron_pattern_id: null,
    });
  });

  it('takes ownership of a row the part-time pattern created', async () => {
    const f = createFixture();
    // Precondition: the pattern really does own this slot.
    expect(row(f.personId, f.mondaySlotId)).toMatchObject({
      blocking_level: 'ABSOLUUT',
      source: 'PARTTIME',
      bron_pattern_id: f.patternId,
    });

    const res = await patch(f.personId, f.mondaySlotId, 'VOORKEUR');
    expect(res.status).toBe(200);

    expect(row(f.personId, f.mondaySlotId)).toMatchObject({
      blocking_level: 'VOORKEUR',
      source: 'MANUAL',
      bron_pattern_id: null,
      bron_absence_id: null,
    });
  });

  it('keeps that choice when the pattern is reconciled again', async () => {
    // This is the failure the ownership transfer exists to prevent:
    // reconcilePatternForPeriod deletes its rows by bron_pattern_id, so a
    // row still carrying that id disappears with them.
    const f = createFixture();
    await patch(f.personId, f.mondaySlotId, 'LIEVER_NIET');

    // Narrow the pattern so this Monday is no longer one of its days.
    db.prepare(
      `UPDATE dienstrooster_parttime_pattern SET weekdag = 'DI' WHERE id = ?`
    ).run(f.patternId);
    syncAvailabilityForPattern(f.patternId);

    const after = row(f.personId, f.mondaySlotId);
    expect(after).toBeDefined();
    expect(after!.blocking_level).toBe('LIEVER_NIET');
  });

  it('clearing a pattern day lets the pattern take it back', async () => {
    // The other direction, which already worked and must keep working:
    // clearing deletes the row and then re-syncs, so a part-time free day
    // cannot be emptied out and left unprotected.
    const f = createFixture();
    await patch(f.personId, f.mondaySlotId, 'VOORKEUR');
    const res = await patch(f.personId, f.mondaySlotId, null);
    expect(res.status).toBe(200);

    expect(row(f.personId, f.mondaySlotId)).toMatchObject({
      blocking_level: 'ABSOLUUT',
      source: 'PARTTIME',
      bron_pattern_id: f.patternId,
    });
  });

  it('saving the same slot twice updates it instead of failing on the unique index', async () => {
    const f = createFixture();
    const free = db
      .prepare(`SELECT id FROM dienstrooster_shift_slot WHERE period_id = ? AND datum = '2027-01-11'`)
      .get(f.periodId) as { id: string };

    expect((await patch(f.personId, free.id, 'VOORKEUR')).status).toBe(200);
    expect((await patch(f.personId, free.id, 'LIEVER_NIET')).status).toBe(200);

    expect(row(f.personId, free.id)!.blocking_level).toBe('LIEVER_NIET');
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?')
      .get(f.personId, free.id) as { c: number };
    expect(count.c).toBe(1);
  });

  it('marks the submission as started', async () => {
    const f = createFixture();
    const free = db
      .prepare(`SELECT id FROM dienstrooster_shift_slot WHERE period_id = ? AND datum = '2027-01-11'`)
      .get(f.periodId) as { id: string };

    await patch(f.personId, free.id, 'VOORKEUR');

    const submission = db
      .prepare('SELECT status FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?')
      .get(f.personId, f.periodId) as { status: string } | undefined;
    expect(submission?.status).toBe('BEZIG');
  });
});
