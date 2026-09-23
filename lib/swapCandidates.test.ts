import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { getSwapCandidates } from './swapCandidates';

/**
 * The hard rules:
 * - every colleague is labelled by how they stand towards the day they
 *   would receive (the requester's offered shift): blocked, voorkeur,
 *   liever niet, already working that week, or nothing marked.
 * - a swap the window rule would refuse is labelled NIET_MOGELIJK, so the
 *   dialog never offers a request that can't go through.
 * - past shifts and other shift types are not offered at all.
 */

const created = { pools: [] as string[], people: [] as string[] };

function createFixture(windowWeeks: number) {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`
  ).run(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Pool', ?, datetime('now'))`
  ).run(poolId, rulesetId);
  created.pools.push(poolId);
  const avond = crypto.randomUUID();
  const weekend = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`).run(
    avond,
    poolId
  );
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Weekend', 'WEEKEND')`
  ).run(weekend, poolId);
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'P', '2099-03-02', '2099-04-26', '2099-01-01T00:00', 'GEPUBLICEERD', ?, datetime('now'))`
  ).run(periodId, poolId, JSON.stringify({ windowWeeks }));

  const person = (label: string) => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
    ).run(id, `${label}-${id.slice(0, 6)}`);
    created.people.push(id);
    return id;
  };
  const shift = (personId: string, datum: string, week: number, type = avond) => {
    const slotId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
       VALUES (?, ?, ?, ?, 2099, ?)`
    ).run(slotId, periodId, type, datum, week);
    db.prepare(
      `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
       VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
    ).run(crypto.randomUUID(), periodId, personId, slotId);
    return slotId;
  };
  const mark = (personId: string, slotId: string, level: string) =>
    db.prepare(
      `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
       VALUES (?, ?, ?, ?, 'MANUAL', datetime('now'))`
    ).run(crypto.randomUUID(), personId, slotId, level);

  const requester = person('Aanvrager');
  const offered = shift(requester, '2099-03-03', 10);
  return { periodId, requester, offered, person, shift, mark, weekend };
}

afterEach(() => {
  for (const poolId of created.pools) {
    for (const { id } of db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?').all(poolId) as Array<{
      id: string;
    }>) {
      db.prepare(
        'DELETE FROM dienstrooster_availability WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)'
      ).run(id);
      db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as { ruleset_id: string };
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  for (const id of created.people) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  created.pools = [];
  created.people = [];
});

// By slot, not by person: a colleague with two shifts is two candidates,
// and swapping for one of them can be fine while the other conflicts.
function categoryOf(result: ReturnType<typeof getSwapCandidates>, slotId: string) {
  if (!result.ok) throw new Error(result.message);
  return result.candidates.find((c) => c.slot_id === slotId)?.category;
}

describe('getSwapCandidates', () => {
  it("labels each colleague by how they stand towards the offered day", () => {
    const f = createFixture(2);
    const blocked = f.person('Blok');
    const likes = f.person('Graag');
    const ratherNot = f.person('Liever');
    const neutral = f.person('Neutraal');
    const tooClose = f.person('Dichtbij');

    const blockedShift = f.shift(blocked, '2099-04-06', 15);
    const likesShift = f.shift(likes, '2099-04-07', 15);
    const ratherNotShift = f.shift(ratherNot, '2099-04-08', 15);
    const neutralShift = f.shift(neutral, '2099-04-09', 15);
    const tooCloseShift = f.shift(tooClose, '2099-04-13', 16);
    // Giving up their week-16 shift for the offered week-10 one would put
    // them a week from their own week-11 shift - the window rule refuses
    // that. (Swapping that week-11 shift itself is fine: it goes away.)
    const tooCloseOther = f.shift(tooClose, '2099-03-09', 11);

    f.mark(blocked, f.offered, 'ABSOLUUT');
    f.mark(likes, f.offered, 'VOORKEUR');
    f.mark(ratherNot, f.offered, 'LIEVER_NIET');

    const result = getSwapCandidates(f.requester, f.periodId, f.offered);
    expect(categoryOf(result, blockedShift)).toBe('GEBLOKKEERD');
    expect(categoryOf(result, likesShift)).toBe('VOORKEUR');
    expect(categoryOf(result, ratherNotShift)).toBe('LIEVER_NIET');
    expect(categoryOf(result, neutralShift)).toBe('BESCHIKBAAR');
    expect(categoryOf(result, tooCloseShift)).toBe('NIET_MOGELIJK');
    expect(categoryOf(result, tooCloseOther)).toBe('BESCHIKBAAR');
  });

  it('flags a colleague who already works that week, when the window rule itself allows it', () => {
    const f = createFixture(0);
    const busy = f.person('Druk');
    const later = f.shift(busy, '2099-04-06', 15);
    f.shift(busy, '2099-03-05', 10);

    expect(categoryOf(getSwapCandidates(f.requester, f.periodId, f.offered), later)).toBe('ZELFDE_WEEK');
  });

  it('leaves out past shifts and other shift types', () => {
    const f = createFixture(2);
    const past = f.person('Verleden');
    const weekendOnly = f.person('Weekend');
    const pastShift = f.shift(past, '2020-01-07', 2);
    const weekendShift = f.shift(weekendOnly, '2099-04-11', 15, f.weekend);

    const result = getSwapCandidates(f.requester, f.periodId, f.offered);
    expect(categoryOf(result, pastShift)).toBeUndefined();
    expect(categoryOf(result, weekendShift)).toBeUndefined();
  });

  it("refuses a shift that isn't the requester's own", () => {
    const f = createFixture(2);
    const other = f.person('Ander');
    const theirs = f.shift(other, '2099-04-06', 15);
    const result = getSwapCandidates(f.requester, f.periodId, theirs);
    expect(result.ok).toBe(false);
  });
});
