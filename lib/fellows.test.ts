import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  PERSON_SESSION_MAX_AGE_SECONDS,
  STAFF_SESSION_MAX_AGE_SECONDS,
} from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { PATCH as patchSlot } from '@/app/api/person/[id]/preferences/slot/[slotId]/route';
import { GET as getFellow, PUT as putFellow } from '@/app/api/person/[id]/fellow/route';
import { setFellow, isFellow, releasedWeekendDays } from './fellows';
import { computeMemberTargets, resolvePeriodBands } from './rosterBands';
import { checkBlockBudget } from './blockBudget';
import { removeAbsenceAvailability, syncAvailabilityForAbsence } from './absenceSync';
import { removePatternAvailability, syncAvailabilityForPattern } from './parttimeSync';
import { computeCarryOver } from './carryOver';
import { checkWeekendCapacity } from './capacity';
import { getEligiblePeopleForSlot } from './rosterGaps';
import { indicatieTekst } from './periodInvitations';

/**
 * Fellows support the AIOS on the voorwacht on Saturdays, so they don't do
 * weekends. The rules:
 * - ticking "Ik ben fellow" blocks every Saturday and Sunday of the period,
 *   a feestdag on a weekend included, never a weekday feestdag, and never
 *   over a day the person marked themselves;
 * - unticking removes exactly those blocks, nothing the person set;
 * - the blocks never count against a block budget;
 * - the others' weekend band goes up, the fellow's own is 0 up to the
 *   weekend days they released, without the ledger;
 * - a fellow's weekend saldo waits instead of growing or disappearing.
 *
 * Fixture period: 2028-04-10 (Mon) to 2028-04-23 (Sun). Easter Sunday
 * 2028-04-16 and Easter Monday 2028-04-17 are FEESTDAG slots, the other
 * Saturdays and Sundays WEEKEND, the rest AVOND.
 */

const START = '2028-04-10';
const END = '2028-04-23';
const FEESTDAGEN = new Set(['2028-04-16', '2028-04-17']);

interface Fixture {
  poolId: string;
  rulesetId: string;
  periodId: string;
  people: string[];
  slotByDate: Map<string, string>;
  tellerByDate: Map<string, string>;
}

const created: Fixture[] = [];

function createFixture(opts: { people?: number; config?: Record<string, unknown>; status?: string; deadline?: string } = {}): Fixture {
  const rulesetId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`).run(
    rulesetId
  );
  const poolId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'P', ?, datetime('now'))`).run(
    poolId,
    rulesetId
  );
  const typeByTeller = new Map<string, string>();
  for (const teller of ['AVOND', 'WEEKEND', 'FEESTDAG']) {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, ?, ?)`).run(id, poolId, teller, teller);
    typeByTeller.set(teller, id);
  }
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'Fellowtest', ?, ?, ?, ?, ?, datetime('now'))`
  ).run(periodId, poolId, START, END, opts.deadline ?? '2099-01-01T00:00:00Z', opts.status ?? 'OPEN', JSON.stringify(opts.config ?? {}));

  const slotByDate = new Map<string, string>();
  const tellerByDate = new Map<string, string>();
  for (let t = Date.parse(`${START}T00:00:00Z`); t <= Date.parse(`${END}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    const datum = d.toISOString().slice(0, 10);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    const teller = FEESTDAGEN.has(datum) ? 'FEESTDAG' : weekend ? 'WEEKEND' : 'AVOND';
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week, benodigd_aantal_personen)
       VALUES (?, ?, ?, ?, 2028, 15, 1)`
    ).run(id, periodId, typeByTeller.get(teller), datum);
    slotByDate.set(datum, id);
    tellerByDate.set(datum, teller);
  }

  const people: string[] = [];
  for (let i = 0; i < (opts.people ?? 1); i++) {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
    ).run(id, `FT-${i}-${id.slice(0, 6)}`);
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, '2020-01-01', '2100-12-31')`
    ).run(crypto.randomUUID(), id, poolId);
    db.prepare(
      `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
    ).run(crypto.randomUUID(), id, hashToken(`ft-${crypto.randomUUID()}`));
    people.push(id);
  }
  const fixture = { poolId, rulesetId, periodId, people, slotByDate, tellerByDate };
  created.push(fixture);
  return fixture;
}

const staffIds: string[] = [];
function createPlanner(): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'PLANNER', 1, datetime('now'))`
  ).run(id, `FT-planner-${id.slice(0, 6)}`);
  staffIds.push(id);
  return id;
}

function cookie(personId: string, kind: 'person' | 'staff' = 'person') {
  const token = createSessionToken(
    { kind, personId, sessionVersion: getSessionVersion(personId)! } as never,
    kind === 'staff' ? STAFF_SESSION_MAX_AGE_SECONDS : PERSON_SESSION_MAX_AGE_SECONDS
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

afterEach(() => {
  for (const f of created) {
    for (const personId of f.people) {
      db.prepare('DELETE FROM dienstrooster_availability WHERE person_id = ?').run(personId);
      db.prepare('DELETE FROM dienstrooster_absence WHERE person_id = ?').run(personId);
      db.prepare('DELETE FROM dienstrooster_parttime_pattern WHERE person_id = ?').run(personId);
    }
    db.prepare('DELETE FROM dienstrooster_period_fellow WHERE period_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_submission WHERE schedule_period_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(f.poolId);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(f.poolId);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(f.poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(f.rulesetId);
    for (const personId of f.people) {
      db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(personId);
      db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
      db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
    }
  }
  created.length = 0;
  for (const id of staffIds) {
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
  staffIds.length = 0;
});

function marks(personId: string, f: Fixture) {
  const rows = db
    .prepare(
      `SELECT s.datum, a.blocking_level, a.fellow_blok FROM dienstrooster_availability a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       WHERE a.person_id = ? AND s.period_id = ?`
    )
    .all(personId, f.periodId) as Array<{ datum: string; blocking_level: string; fellow_blok: number }>;
  return new Map(rows.map((r) => [r.datum, r]));
}

function mark(personId: string, slotId: string, level: string) {
  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'MANUAL', datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId, level);
}

async function patch(personId: string, slotId: string, level: string | null) {
  return patchSlot(
    new NextRequest(`http://localhost/api/person/${personId}/preferences/slot/${slotId}`, {
      method: 'PATCH',
      headers: { Cookie: cookie(personId), 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    }),
    { params: Promise.resolve({ id: personId, slotId }) }
  );
}

describe('Ik ben fellow: de weekendblokkades', () => {
  it('blocks every Saturday and Sunday, Easter Sunday too, never a weekday feestdag or a day marked by hand', () => {
    const f = createFixture();
    const [p] = f.people;
    mark(p, f.slotByDate.get('2028-04-15')!, 'VOORKEUR');

    expect(setFellow(f.periodId, p, true)).toBe(true);
    const m = marks(p, f);

    for (const datum of ['2028-04-16', '2028-04-22', '2028-04-23']) {
      expect(m.get(datum)).toMatchObject({ blocking_level: 'ABSOLUUT', fellow_blok: 1 });
    }
    // Their own voorkeur for that Saturday stays theirs.
    expect(m.get('2028-04-15')).toMatchObject({ blocking_level: 'VOORKEUR', fellow_blok: 0 });
    // Easter Monday and every other weekday stay open.
    expect(m.has('2028-04-17')).toBe(false);
    expect([...m.keys()].sort()).toEqual(['2028-04-15', '2028-04-16', '2028-04-22', '2028-04-23']);
    expect(isFellow(f.periodId, p)).toBe(true);
  });

  it('unticking removes only its own blocks, not a day the fellow took over by hand', async () => {
    const f = createFixture();
    const [p] = f.people;
    setFellow(f.periodId, p, true);
    // Marking a fellow-blocked day by hand makes it their own.
    expect((await patch(p, f.slotByDate.get('2028-04-22')!, 'ABSOLUUT')).status).toBe(200);

    expect(setFellow(f.periodId, p, false)).toBe(true);
    const m = marks(p, f);
    expect([...m.keys()]).toEqual(['2028-04-22']);
    expect(m.get('2028-04-22')).toMatchObject({ blocking_level: 'ABSOLUUT', fellow_blok: 0 });
    expect(isFellow(f.periodId, p)).toBe(false);
  });

  it('counts the weekend days a fellow released as the most weekend shifts they can get', async () => {
    const f = createFixture();
    const [p] = f.people;
    setFellow(f.periodId, p, true);
    // WEEKEND slots: 15, 22, 23 (16 is a feestdag). All blocked.
    expect(releasedWeekendDays(f.periodId).get(p)).toBe(0);
    expect((await patch(p, f.slotByDate.get('2028-04-22')!, null)).status).toBe(200);
    expect((await patch(p, f.slotByDate.get('2028-04-23')!, 'VOORKEUR')).status).toBe(200);
    expect(releasedWeekendDays(f.periodId).get(p)).toBe(2);
  });

  it('lets a vacation take over a fellow block, so unticking does not open the day', () => {
    const f = createFixture();
    const [p] = f.people;
    setFellow(f.periodId, p, true);
    const absenceId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_absence (id, person_id, van_datum, tot_datum, soort, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, '2028-04-22', '2028-04-23', 'VAKANTIE', ?, datetime('now'))`
    ).run(absenceId, p, p);
    syncAvailabilityForAbsence(absenceId);

    // Shown as the vacation it is, not as a fellow block.
    const source = (datum: string) =>
      (
        db
          .prepare(
            `SELECT a.source, a.fellow_blok FROM dienstrooster_availability a
             WHERE a.person_id = ? AND a.slot_id = ?`
          )
          .get(p, f.slotByDate.get(datum)) as { source: string; fellow_blok: number }
      );
    expect(source('2028-04-22')).toEqual({ source: 'ABSENCE', fellow_blok: 0 });

    setFellow(f.periodId, p, false);
    const m = marks(p, f);
    expect(m.get('2028-04-22')?.blocking_level).toBe('ABSOLUUT');
    expect(m.get('2028-04-23')?.blocking_level).toBe('ABSOLUUT');
    expect(m.has('2028-04-16')).toBe(false);
  });

  it('gives a part-time Saturday its block back when "fellow" is unticked', () => {
    const f = createFixture();
    const [p] = f.people;
    setFellow(f.periodId, p, true);
    // A Saturday pattern added while the fellow blocks already hold those days.
    db.prepare(
      `INSERT INTO dienstrooster_parttime_pattern
         (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, 'ZA', 'ELKE_WEEK', '2028-01-01', '2028-12-31', ?, datetime('now'))`
    ).run(crypto.randomUUID(), p, p);

    setFellow(f.periodId, p, false);
    const m = marks(p, f);
    expect(m.get('2028-04-15')?.blocking_level).toBe('ABSOLUUT');
    expect(m.get('2028-04-22')?.blocking_level).toBe('ABSOLUUT');
    expect(m.has('2028-04-23')).toBe(false);
  });

  it('turns a weekend day back into a fellow block when the vacation holding it is removed or shortened', () => {
    const f = createFixture();
    const [p] = f.people;
    setFellow(f.periodId, p, true);
    const absenceId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_absence (id, person_id, van_datum, tot_datum, soort, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, '2028-04-15', '2028-04-23', 'VAKANTIE', ?, datetime('now'))`
    ).run(absenceId, p, p);
    syncAvailabilityForAbsence(absenceId);

    // Shortened to the last weekend: the first one is no longer the vacation's.
    db.prepare(`UPDATE dienstrooster_absence SET van_datum = '2028-04-22' WHERE id = ?`).run(absenceId);
    syncAvailabilityForAbsence(absenceId);
    expect(marks(p, f).get('2028-04-15')).toMatchObject({ blocking_level: 'ABSOLUUT', fellow_blok: 1 });

    // Removed altogether.
    removeAbsenceAvailability(absenceId);
    db.prepare('DELETE FROM dienstrooster_absence WHERE id = ?').run(absenceId);
    expect(marks(p, f).get('2028-04-22')).toMatchObject({ blocking_level: 'ABSOLUUT', fellow_blok: 1 });
    // A weekday of that vacation just opens.
    expect(marks(p, f).has('2028-04-19')).toBe(false);
    expect(releasedWeekendDays(f.periodId).get(p)).toBe(0);
  });

  it('turns a part-time Saturday that was there before "fellow" into a fellow block when the pattern goes', () => {
    const f = createFixture();
    const [p] = f.people;
    const patternId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_parttime_pattern
         (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, 'ZA', 'ELKE_WEEK', '2028-01-01', '2028-12-31', ?, datetime('now'))`
    ).run(patternId, p, p);
    syncAvailabilityForPattern(patternId);
    setFellow(f.periodId, p, true);
    expect(marks(p, f).get('2028-04-15')?.fellow_blok).toBe(0);

    removePatternAvailability(patternId);
    expect(marks(p, f).get('2028-04-15')).toMatchObject({ blocking_level: 'ABSOLUUT', fellow_blok: 1 });
    expect(marks(p, f).get('2028-04-22')).toMatchObject({ blocking_level: 'ABSOLUUT', fellow_blok: 1 });
    db.prepare('DELETE FROM dienstrooster_parttime_pattern WHERE id = ?').run(patternId);
  });

  it('leaves a weekend day the fellow released themselves open, and gives nobody else a fellow block', () => {
    const f = createFixture({ people: 2 });
    const [p, other] = f.people;
    setFellow(f.periodId, p, true);
    // Released by the fellow: the row is simply gone.
    db.prepare('DELETE FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?').run(
      p,
      f.slotByDate.get('2028-04-23')
    );
    for (const who of [p, other]) {
      const absenceId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO dienstrooster_absence (id, person_id, van_datum, tot_datum, soort, aangemaakt_door, aangemaakt_op)
         VALUES (?, ?, '2028-04-22', '2028-04-22', 'VAKANTIE', ?, datetime('now'))`
      ).run(absenceId, who, who);
      syncAvailabilityForAbsence(absenceId);
      removeAbsenceAvailability(absenceId);
      db.prepare('DELETE FROM dienstrooster_absence WHERE id = ?').run(absenceId);
    }
    expect(marks(p, f).has('2028-04-23')).toBe(false);
    expect(marks(p, f).get('2028-04-22')?.fellow_blok).toBe(1);
    expect(marks(other, f).has('2028-04-22')).toBe(false);
  });

  it('never counts the weekend blocks against a block budget', () => {
    // One WEEKEND block allowed: floor(3 * 0.34).
    const config = {
      blockBudget: {
        AVOND: { maxFraction: 1 },
        WEEKEND: { maxFraction: 0.34 },
        FEESTDAG: { maxFraction: 1 },
        parttimeExempt: true,
      },
    };
    const f = createFixture({ config });
    const [p] = f.people;
    setFellow(f.periodId, p, true);
    const result = checkBlockBudget({
      period: { bevroren_ruleset_json: JSON.stringify(config), pool_id: f.poolId },
      periodId: f.periodId,
      personId: p,
      teller: 'WEEKEND',
      level: 'ABSOLUUT',
      excludeSlotId: f.slotByDate.get('2028-04-15')!,
    });
    expect(result.allowed).toBe(true);
  });
});

describe('streefbereik met fellows', () => {
  it('raises the others\' configured weekend band by people / (people - fellows), and leaves the rest alone', () => {
    const counts = { AVOND: 110, WEEKEND: 44, FEESTDAG: 4 };
    const config = { bandAvond: [3, 4], bandWeekend: [1, 2], bandFeestdag: [0, 1] };
    expect(resolvePeriodBands(config, counts, 31, 0)).toEqual({ AVOND: [3, 4], WEEKEND: [1, 2], FEESTDAG: [0, 1] });
    // 31 / 26: floor(1.19) = 1, ceil(2.38) = 3.
    expect(resolvePeriodBands(config, counts, 31, 5)).toEqual({ AVOND: [3, 4], WEEKEND: [1, 3], FEESTDAG: [0, 1] });
  });

  it('works the default weekend band out over the non-fellows when none is configured', () => {
    const counts = { AVOND: 0, WEEKEND: 60, FEESTDAG: 0 };
    // 60 / 30 = 2 -> [2, 3]; 60 / 20 = 3 -> [3, 4].
    expect(resolvePeriodBands({}, counts, 30, 0).WEEKEND).toEqual([2, 3]);
    expect(resolvePeriodBands({}, counts, 30, 10).WEEKEND).toEqual([3, 4]);
  });

  it('gives a fellow 0 up to their released days, without the ledger, and the others a raised band', async () => {
    const f = createFixture({ people: 4, config: { bandWeekend: [1, 1] } });
    const [fellow, ander] = f.people;
    setFellow(f.periodId, fellow, true);
    db.prepare(
      `INSERT INTO dienstrooster_ledger_entry (id, person_id, pool_id, teller, geldt_voor_periode_id, delta, reden, categorie, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, 'WEEKEND', ?, 2, 'test', 'CORRECTIE', ?, datetime('now'))`
    ).run(crypto.randomUUID(), fellow, f.poolId, f.periodId, fellow);

    let targets = computeMemberTargets(f.periodId);
    expect(targets.get(fellow)!.WEEKEND).toEqual({ min: 0, max: 0, fellow: true });
    // 4 / 3: [floor(1.33), ceil(1.33)] = [1, 2].
    expect(targets.get(ander)!.WEEKEND).toEqual({ min: 1, max: 2, fellow: false });

    await patch(fellow, f.slotByDate.get('2028-04-22')!, null);
    targets = computeMemberTargets(f.periodId);
    expect(targets.get(fellow)!.WEEKEND).toEqual({ min: 0, max: 1, fellow: true });
  });

  it('keeps a fellow\'s weekend saldo: shifts taken anyway pay off debt, nothing new is added', () => {
    const f = createFixture({ people: 2, config: { bandWeekend: [1, 2] } });
    const [fellow, ander] = f.people;
    setFellow(f.periodId, fellow, true);
    db.prepare(
      `INSERT INTO dienstrooster_ledger_entry (id, person_id, pool_id, teller, geldt_voor_periode_id, delta, reden, categorie, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, 'WEEKEND', ?, 2, 'test', 'CORRECTIE', ?, datetime('now'))`
    ).run(crypto.randomUUID(), fellow, f.poolId, f.periodId, fellow);
    db.prepare(
      `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
       VALUES (?, ?, ?, ?, 'MANUAL', 1, datetime('now'))`
    ).run(crypto.randomUUID(), f.periodId, fellow, f.slotByDate.get('2028-04-22'));

    const period = db
      .prepare('SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?')
      .get(f.periodId) as Parameters<typeof computeCarryOver>[0];
    const entries = computeCarryOver(period);
    const weekend = (id: string) => entries.find((e) => e.person_id === id && e.teller === 'WEEKEND');
    expect(weekend(fellow)?.delta).toBe(1);
    // The other person had a raised band [2, 4] with nothing done: 2 to make up.
    expect(weekend(ander)?.delta).toBe(2);
  });
});

describe('weekendcapaciteit zonder fellows', () => {
  it('passes when the others can cover the weekend days with this window', () => {
    // 20 weeks, window 4: each does 5; 26 * 5 >= 44 and 26 >= 8.
    expect(checkWeekendCapacity(20, 4, 26, 44)).toEqual({ passed: true, suggestedWindow: null });
  });

  it('suggests the largest window that does fit', () => {
    // 20 weeks, 10 people, 40 weekend days: window 5 gives 10*4 = 40 but needs 10 people per window (ok);
    // window 6 gives 10*3 = 30 < 40.
    expect(checkWeekendCapacity(20, 6, 10, 40)).toEqual({ passed: false, suggestedWindow: 5 });
  });

  it('says so when not even a window of one week fits', () => {
    expect(checkWeekendCapacity(4, 2, 1, 8)).toEqual({ passed: false, suggestedWindow: null });
  });
});

describe('fellows in de keuzelijsten', () => {
  it('puts fellows in their own group on a fellow-blocked weekend day, and at the bottom of the list', async () => {
    const f = createFixture({ people: 3 });
    const [a, b, c] = f.people;
    setFellow(f.periodId, a, true);
    setFellow(f.periodId, b, true);
    // b released that Saturday: then it is b's own availability, not a fellow block.
    await patch(b, f.slotByDate.get('2028-04-22')!, 'VOORKEUR');

    const eligible = getEligiblePeopleForSlot(f.periodId, f.slotByDate.get('2028-04-22')!);
    expect(eligible.map((p) => p.id)).toEqual([c, a, b]);
    expect(eligible.find((p) => p.id === a)).toMatchObject({ category: 'FELLOW', fellow: true });
    expect(eligible.find((p) => p.id === b)).toMatchObject({ category: 'VOORKEUR', fellow: true });
    expect(eligible.find((p) => p.id === c)).toMatchObject({ category: 'BESCHIKBAAR', fellow: false });
  });
});

describe('het vinkje via de app', () => {
  const put = (personId: string, periodId: string, fellow: boolean, as: string, kind: 'person' | 'staff') =>
    putFellow(
      new NextRequest(`http://localhost/api/person/${personId}/fellow`, {
        method: 'PUT',
        headers: { Cookie: cookie(as, kind), 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_id: periodId, fellow }),
      }),
      { params: Promise.resolve({ id: personId }) }
    );

  it('lets the participant tick it before the deadline, not after', async () => {
    const open = createFixture();
    expect((await put(open.people[0], open.periodId, true, open.people[0], 'person')).status).toBe(200);
    expect(isFellow(open.periodId, open.people[0])).toBe(true);

    const closed = createFixture({ deadline: '2020-01-01T00:00:00Z' });
    expect((await put(closed.people[0], closed.periodId, true, closed.people[0], 'person')).status).toBe(403);
    expect(isFellow(closed.periodId, closed.people[0])).toBe(false);

    const res = await getFellow(
      new NextRequest(`http://localhost/api/person/${closed.people[0]}/fellow?period_id=${closed.periodId}`, {
        headers: { Cookie: cookie(closed.people[0]) },
      }),
      { params: Promise.resolve({ id: closed.people[0] }) }
    );
    expect((await res.json()).data).toMatchObject({ fellow: false, wijzigbaar: false });
  });

  it('lets the planner change it after the deadline, on record in the audit trail', async () => {
    const closed = createFixture({ deadline: '2020-01-01T00:00:00Z', status: 'GESLOTEN' });
    const planner = createPlanner();
    expect((await put(closed.people[0], closed.periodId, true, planner, 'staff')).status).toBe(200);
    expect(isFellow(closed.periodId, closed.people[0])).toBe(true);
    const audit = db
      .prepare(`SELECT COUNT(*) AS n FROM dienstrooster_audit_log WHERE actor_id = ? AND entiteit = 'period_fellow'`)
      .get(planner) as { n: number };
    expect(audit.n).toBe(1);
  });

  it('is fixed for the planner too once the roster is generated or published', async () => {
    const planner = createPlanner();
    for (const status of ['GEGENEREERD', 'GEPUBLICEERD']) {
      const made = createFixture({ people: 2, deadline: '2020-01-01T00:00:00Z', status });
      setFellow(made.periodId, made.people[1], true);
      const aan = await put(made.people[0], made.periodId, true, planner, 'staff');
      expect(aan.status).toBe(409);
      expect((await aan.json()).error.message).toContain('Het rooster is al gemaakt');
      expect((await put(made.people[1], made.periodId, false, planner, 'staff')).status).toBe(409);
      expect(isFellow(made.periodId, made.people[0])).toBe(false);
      expect(isFellow(made.periodId, made.people[1])).toBe(true);
    }
  });
});

describe('de indicatie in de uitnodiging', () => {
  it('names the top of each range in words, leaves out nothing-to-expect and a fellow\'s weekend', () => {
    const t = (min: number, max: number, fellow = false) => ({ min, max, fellow });
    expect(indicatieTekst({ AVOND: t(8, 9), WEEKEND: t(1, 2), FEESTDAG: t(0, 1) })).toContain(
      'Naar verwachting krijg je ongeveer 9 avonddiensten, ongeveer 2 weekenddiensten en ongeveer 1 feestdagdienst.'
    );
    expect(indicatieTekst({ AVOND: t(8, 9), WEEKEND: t(0, 0, true), FEESTDAG: t(0, 0) })).toContain(
      'Naar verwachting krijg je ongeveer 9 avonddiensten.'
    );
    expect(indicatieTekst({ AVOND: t(0, 0), WEEKEND: t(0, 0), FEESTDAG: t(0, 0) })).toBe('');
  });
});
