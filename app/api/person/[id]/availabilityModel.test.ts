import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fc from 'fast-check';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { matchSlotsToPattern, syncPatternsForPerson, type Weekdag, type Frequentie } from '@/lib/parttimeSync';
import { matchSlotsToAbsence, syncAbsencesForPerson } from '@/lib/absenceSync';
import { PATCH as markSlot } from './preferences/slot/[slotId]/route';
import { POST as addAbsence } from './absences/route';
import { PATCH as editAbsence, DELETE as removeAbsence } from './absences/[absenceId]/route';
import { POST as addPattern } from './parttime-patterns/route';
import { PATCH as editPattern, DELETE as removePattern } from './parttime-patterns/[patternId]/route';
import { PUT as setFellow } from './fellow/route';

/**
 * A participant's availability as a state machine, through the real routes.
 *
 * One row per person per day holds whatever wins of: a marking made by
 * hand, a part-time pattern, an absence and a fellow's weekend block
 * (CLAUDE.md, "Absences and part-time over what someone marked by hand",
 * "Fellows"). Each route reconciles what it touched. Random sequences of
 * marking days, adding, changing and removing absences and patterns, and
 * ticking "fellow" on and off - and after every step:
 *
 * - settled: running every pattern and absence sync once more changes
 *   nothing. A state that a later, unrelated action would change is one
 *   the planner and the solver see differently depending on what happened
 *   next;
 * - a day inside an absence is blocked ("a vacation day must never stay
 *   open to the solver");
 * - a day a part-time pattern covers is blocked, or marked "voorkeur" by
 *   the person (they want to work that day);
 * - every part-time or absence row belongs to a pattern or absence that
 *   still exists and still covers that day;
 * - fellow blocks only on a fellow's weekend days, and every weekend day
 *   of a fellow is blocked unless they marked or cleared it themselves.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const START = '2099-03-02'; // Monday
const DAYS = 28;
const WEEKDAGEN: Weekdag[] = ['MA', 'DI', 'WO', 'DO', 'VR'];
const FREQUENTIES: Frequentie[] = ['ELKE_WEEK', 'EVEN_WEKEN', 'ONEVEN_WEKEN'];
const LEVELS = ['ABSOLUUT', 'LIEVER_NIET', 'VOORKEUR', null] as const;

interface Slot {
  id: string;
  datum: string;
  iso_week: number;
  weekend: boolean;
}

interface Row {
  slot_id: string;
  blocking_level: string | null;
  source: string;
  bron_pattern_id: string | null;
  bron_absence_id: string | null;
  fellow_blok: number;
}

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

const day = (i: number) => new Date(Date.parse(`${START}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);

/** A fresh person in a fresh OPEN period with an avond- or weekend slot every day. */
function buildPerson(): { person: string; period: string; slots: Slot[] } {
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Beschikbaarheid', config_json: '{}', aangemaakt_op: now });
  const pool = insert('dienstrooster_pool', { naam: 'Beschikbaarheid', ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: pool, naam: 'Avond', teller: 'AVOND' });
  const weekend = insert('dienstrooster_shift_type', { pool_id: pool, naam: 'Weekend', teller: 'WEEKEND' });
  const period = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: 'Beschikbaarheid',
    start_datum: START,
    eind_datum: day(DAYS - 1),
    deadline: '2099-01-01T00:00',
    status: 'OPEN',
    bevroren_ruleset_json: '{"windowWeeks":2}',
    aangemaakt_op: now,
  });
  const person = insert('dienstrooster_person', { codenaam: `Beschikbaar-${crypto.randomUUID().slice(0, 8)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  insert('dienstrooster_pool_membership', { person_id: person, pool_id: pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  insert('dienstrooster_person_access_link', { person_id: person, token_hash: crypto.randomBytes(32).toString('hex'), geldt_voor_periode_id: period, aangemaakt_op: now });
  const slots: Slot[] = [];
  for (let i = 0; i < DAYS; i++) {
    const datum = day(i);
    const isWeekend = i % 7 >= 5;
    const iso_week = 10 + Math.floor(i / 7); // 2099-03-02 is the Monday of ISO week 10
    const id = insert('dienstrooster_shift_slot', {
      period_id: period,
      shift_type_id: isWeekend ? weekend : avond,
      datum,
      iso_jaar: 2099,
      iso_week,
      is_feestdag: 0,
      benodigd_aantal_personen: 1,
    });
    slots.push({ id, datum, iso_week, weekend: isWeekend });
  }
  return { person, period, slots };
}

function cookie(personId: string): string {
  const token = createSessionToken({ kind: 'person', personId, sessionVersion: getSessionVersion(personId)! }, PERSON_SESSION_MAX_AGE_SECONDS);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

async function call(handler: unknown, method: string, person: string, params: Record<string, string>, body?: unknown) {
  const res = await (handler as Handler)(
    new NextRequest('http://localhost/api/person/x', {
      method,
      headers: { Cookie: cookie(person), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id: person, ...params }) }
  );
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

function rows(person: string): Map<string, Row> {
  return new Map(
    (
      db
        .prepare(
          `SELECT slot_id, blocking_level, source, bron_pattern_id, bron_absence_id, fellow_blok
           FROM dienstrooster_availability WHERE person_id = ?`
        )
        .all(person) as Row[]
    ).map((r) => [r.slot_id, r])
  );
}

type Step =
  | { kind: 'mark'; slot: number; level: (typeof LEVELS)[number] }
  | { kind: 'absence'; from: number; length: number }
  | { kind: 'editAbsence'; which: number; from: number; length: number }
  | { kind: 'removeAbsence'; which: number }
  | { kind: 'pattern'; weekdag: Weekdag; frequentie: Frequentie; from: number; length: number }
  | { kind: 'editPattern'; which: number; weekdag: Weekdag; frequentie: Frequentie }
  | { kind: 'removePattern'; which: number }
  | { kind: 'fellow'; aan: boolean };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('mark' as const), slot: fc.nat(DAYS - 1), level: fc.constantFrom(...LEVELS) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('absence' as const), from: fc.nat(DAYS - 1), length: fc.nat(9) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('editAbsence' as const), which: fc.nat(9), from: fc.nat(DAYS - 1), length: fc.nat(9) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('removeAbsence' as const), which: fc.nat(9) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('pattern' as const),
      weekdag: fc.constantFrom(...WEEKDAGEN),
      frequentie: fc.constantFrom(...FREQUENTIES),
      from: fc.integer({ min: -7, max: DAYS - 1 }),
      length: fc.integer({ min: 0, max: 40 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('editPattern' as const), which: fc.nat(9), weekdag: fc.constantFrom(...WEEKDAGEN), frequentie: fc.constantFrom(...FREQUENTIES) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('removePattern' as const), which: fc.nat(9) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('fellow' as const), aan: fc.boolean() }) }
);

async function runSequence(steps: Step[]): Promise<void> {
  const { person, period, slots } = buildPerson();
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const absences: string[] = [];
  const patterns: string[] = [];
  let fellow = false;
  // Weekend days a fellow marked or cleared themselves: theirs to keep open.
  let released = new Set<string>();

  for (const step of steps) {
    let res: { status: number; json: Record<string, any> } | null = null;
    switch (step.kind) {
      case 'mark': {
        // Any day, any level: the route refuses (409) what cannot stay - a
        // softer marking inside an absence, "liever niet" on a part-time
        // day - and the checks below prove nothing it lets through leaves
        // the state unsettled.
        const slot = slots[step.slot];
        res = await call(markSlot, 'PATCH', person, { slotId: slot.id }, { level: step.level });
        if (res.status < 300 && fellow && slot.weekend) released.add(slot.id);
        break;
      }
      case 'absence':
        res = await call(addAbsence, 'POST', person, {}, { van_datum: day(step.from), tot_datum: day(Math.min(DAYS - 1, step.from + step.length)), soort: 'VAKANTIE' });
        if (res.status < 300) absences.push(res.json.data.id);
        break;
      case 'editAbsence':
        if (absences.length === 0) continue;
        res = await call(editAbsence, 'PATCH', person, { absenceId: absences[step.which % absences.length] }, {
          van_datum: day(step.from),
          tot_datum: day(Math.min(DAYS - 1, step.from + step.length)),
          soort: 'CONGRES',
        });
        break;
      case 'removeAbsence':
        if (absences.length === 0) continue;
        res = await call(removeAbsence, 'DELETE', person, { absenceId: absences[step.which % absences.length] });
        if (res.status < 300) absences.splice(step.which % absences.length, 1);
        break;
      case 'pattern': {
        // Patterns may overlap: switching from an old one to a new one
        // over the same weekday is how a part-timer changes days.
        res = await call(addPattern, 'POST', person, {}, {
          weekdag: step.weekdag,
          frequentie: step.frequentie,
          geldig_vanaf: day(step.from),
          geldig_tot: day(step.from + step.length),
        });
        if (res.status < 300) patterns.push(res.json.data.id);
        break;
      }
      case 'editPattern': {
        if (patterns.length === 0) continue;
        const id = patterns[step.which % patterns.length];
        res = await call(editPattern, 'PATCH', person, { patternId: id }, { weekdag: step.weekdag, frequentie: step.frequentie });
        break;
      }
      case 'removePattern':
        if (patterns.length === 0) continue;
        res = await call(removePattern, 'DELETE', person, { patternId: patterns[step.which % patterns.length] });
        if (res.status < 300) patterns.splice(step.which % patterns.length, 1);
        break;
      case 'fellow': {
        const before = rows(person);
        res = await call(setFellow, 'PUT', person, {}, { period_id: period, fellow: step.aan });
        if (res.status < 300) {
          if (step.aan && !fellow) {
            // Ticking leaves a day the person marked themselves alone.
            released = new Set(slots.filter((s) => s.weekend && before.get(s.id)?.source === 'MANUAL' && !before.get(s.id)?.fellow_blok).map((s) => s.id));
          }
          fellow = step.aan;
        }
        break;
      }
    }
    expect(res!.status, `${JSON.stringify(step)}: ${JSON.stringify(res!.json)}`).toBeLessThan(500);

    const state = rows(person);
    const label = (what: string) => `after ${JSON.stringify(step)}: ${what}`;

    // Settled: nothing left for the syncs to do.
    syncPatternsForPerson(person);
    syncAbsencesForPerson(person);
    expect(rows(person), label('a later sync still changes the availability')).toEqual(state);

    const absenceRows = db.prepare('SELECT id, van_datum, tot_datum FROM dienstrooster_absence WHERE person_id = ?').all(person) as Array<{
      id: string;
      van_datum: string;
      tot_datum: string;
    }>;
    const patternRows = db
      .prepare('SELECT id, weekdag, frequentie, geldig_vanaf, geldig_tot FROM dienstrooster_parttime_pattern WHERE person_id = ?')
      .all(person) as Array<{ id: string; weekdag: Weekdag; frequentie: Frequentie; geldig_vanaf: string; geldig_tot: string }>;

    for (const a of absenceRows) {
      for (const slotId of matchSlotsToAbsence(a, slots)) {
        expect(state.get(slotId)?.blocking_level, label(`absence day ${slotById.get(slotId)!.datum} is not blocked`)).toBe('ABSOLUUT');
      }
    }
    for (const p of patternRows) {
      for (const slotId of matchSlotsToPattern(p, slots)) {
        const row = state.get(slotId);
        const ok = row?.blocking_level === 'ABSOLUUT' || (row?.source === 'MANUAL' && row.blocking_level === 'VOORKEUR');
        expect(ok, label(`part-time day ${slotById.get(slotId)!.datum} is ${JSON.stringify(row ?? 'open')}`)).toBe(true);
      }
    }
    for (const [slotId, row] of state) {
      if (row.source === 'PARTTIME') {
        const p = patternRows.find((x) => x.id === row.bron_pattern_id);
        expect(p && matchSlotsToPattern(p, slots).includes(slotId), label(`part-time row on ${slotById.get(slotId)!.datum} has no pattern covering it`)).toBe(true);
      }
      if (row.source === 'ABSENCE') {
        const a = absenceRows.find((x) => x.id === row.bron_absence_id);
        expect(a && matchSlotsToAbsence(a, slots).includes(slotId), label(`absence row on ${slotById.get(slotId)!.datum} has no absence covering it`)).toBe(true);
      }
      if (row.fellow_blok) {
        expect(fellow && slotById.get(slotId)!.weekend, label(`fellow block on ${slotById.get(slotId)!.datum}`)).toBe(true);
      }
    }
    if (fellow) {
      for (const s of slots.filter((x) => x.weekend && !released.has(x.id))) {
        expect(state.get(s.id)?.blocking_level, label(`fellow weekend day ${s.datum} is open`)).toBe('ABSOLUUT');
      }
    }
  }
}

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('availability: hand markings, part-time, absences and fellow blocks together', () => {
  it('random sequences through the routes always end settled and safe', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 25 }), async (steps) => {
        await runSequence(steps);
      }),
      { numRuns: 60, seed: 3 }
    );
  }, 300_000);

  // Audit 8: the route took a marking on a day an absence or part-time
  // pattern holds, which the calendar never offers: "voorkeur" by hand on a
  // vacation day became a MANUAL row and the block was gone - until the
  // next sync of anything took the absence back. Now refused.
  it('a hand marking on a day an absence holds is refused', async () => {
    const { person, slots } = buildPerson();
    const made = await call(addAbsence, 'POST', person, {}, { van_datum: day(0), tot_datum: day(0), soort: 'VAKANTIE' });
    expect(made.status).toBe(201);
    const res = await call(markSlot, 'PATCH', person, { slotId: slots[0].id }, { level: 'VOORKEUR' });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('IN_AFWEZIGHEID');
    expect(rows(person).get(slots[0].id)?.blocking_level).toBe('ABSOLUUT');
  });

  // Audit 8, and reachable from the calendar: someone blocks a Saturday by
  // hand, then registers a vacation over it (the absence leaves their own
  // block alone), then sets that Saturday to "voorkeur" - their own
  // marking, so the calendar lets them. That left the vacation day open
  // with a preference to work it. Now refused with a reason; clearing it
  // instead hands the day to the absence.
  it('a day inside an absence stays blocked when the person changes their own earlier block on it', async () => {
    const { person, slots } = buildPerson();
    await call(markSlot, 'PATCH', person, { slotId: slots[5].id }, { level: 'ABSOLUUT' });
    expect((await call(addAbsence, 'POST', person, {}, { van_datum: day(0), tot_datum: day(6), soort: 'VAKANTIE' })).status).toBe(201);
    for (const level of ['VOORKEUR', 'LIEVER_NIET']) {
      const res = await call(markSlot, 'PATCH', person, { slotId: slots[5].id }, { level });
      expect(res.status, level).toBe(409);
      expect(res.json.error.code).toBe('IN_AFWEZIGHEID');
      expect(res.json.error.message).toBe('Deze dag valt in je afwezigheid en blijft daarom geblokkeerd. Pas de afwezigheid aan als die niet klopt.');
      expect(rows(person).get(slots[5].id)?.blocking_level).toBe('ABSOLUUT');
    }
    expect((await call(markSlot, 'PATCH', person, { slotId: slots[5].id }, { level: null })).status).toBe(200);
    expect(rows(person).get(slots[5].id)).toMatchObject({ blocking_level: 'ABSOLUUT', source: 'ABSENCE' });
  });

  // The same for a part-time day: "liever niet" on a day the pattern
  // releases for a manual block would be taken back by the next sync.
  // "Voorkeur" stays allowed - someone wanting to work that particular day.
  it('a part-time day the person blocked by hand takes voorkeur but not liever niet', async () => {
    const { person, slots } = buildPerson();
    await call(markSlot, 'PATCH', person, { slotId: slots[0].id }, { level: 'ABSOLUUT' });
    expect((await call(addPattern, 'POST', person, {}, { weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: day(0), geldig_tot: day(27) })).status).toBe(201);
    const res = await call(markSlot, 'PATCH', person, { slotId: slots[0].id }, { level: 'LIEVER_NIET' });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('IN_DEELTIJD');
    expect(rows(person).get(slots[0].id)?.blocking_level).toBe('ABSOLUUT');
    expect((await call(markSlot, 'PATCH', person, { slotId: slots[0].id }, { level: 'VOORKEUR' })).status).toBe(200);
    expect(rows(person).get(slots[0].id)).toMatchObject({ blocking_level: 'VOORKEUR', source: 'MANUAL' });
  });

  // Audit 8: removing (or changing) a part-time pattern re-synced absences
  // but not the person's other patterns. Two patterns over the same day -
  // switching from an old pattern to a new one, the new one added first -
  // and removing the old one left that day open although the new one
  // covers it, until some later sync. The routes refuse a second pattern
  // over a day since 0.94.0 (below), but rows from before may hold two.
  it('removing one of two patterns over the same day leaves it blocked by the other', async () => {
    const { person, slots } = buildPerson();
    const oud = await call(addPattern, 'POST', person, {}, { weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: day(0), geldig_tot: day(13) });
    expect(oud.status).toBe(201);
    db.prepare(
      `INSERT INTO dienstrooster_parttime_pattern (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, 'MA', 'ELKE_WEEK', ?, ?, ?, datetime('now'))`
    ).run(crypto.randomUUID(), person, day(7), day(27), person);
    expect((await call(removePattern, 'DELETE', person, { patternId: oud.json.data.id })).status).toBeLessThan(300);
    expect(rows(person).get(slots[7].id)?.blocking_level).toBe('ABSOLUUT');
  });

  // 0.94.0 (audit): the deelnamefactor counts each pattern, so one weekday has one pattern per week, as the
  // AIOS's routes always insisted.
  describe('one part-time day per weekday and week', () => {
    const patroon = (extra: Record<string, unknown>) => ({ weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: day(0), geldig_tot: day(13), ...extra });

    it('a second pattern with a day in common is refused, and nothing is stored', async () => {
      const { person } = buildPerson();
      expect((await call(addPattern, 'POST', person, {}, patroon({}))).status).toBe(201);
      const dubbel = await call(addPattern, 'POST', person, {}, patroon({ geldig_vanaf: day(7), geldig_tot: day(27) }));
      expect(dubbel.status).toBe(409);
      expect(dubbel.json.error.code).toBe('PATTERN_OVERLAPS');
      const n = db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_parttime_pattern WHERE person_id = ?').get(person) as { n: number };
      expect(n.n).toBe(1);
    });

    it('even and odd weeks of one weekday share no day, another weekday neither, and dates apart neither', async () => {
      const { person } = buildPerson();
      expect((await call(addPattern, 'POST', person, {}, patroon({ frequentie: 'EVEN_WEKEN', geldig_vanaf: day(0), geldig_tot: day(41) }))).status).toBe(201);
      expect((await call(addPattern, 'POST', person, {}, patroon({ frequentie: 'ONEVEN_WEKEN', geldig_vanaf: day(1), geldig_tot: day(40) }))).status).toBe(201);
      expect((await call(addPattern, 'POST', person, {}, patroon({ weekdag: 'DI' }))).status).toBe(201);
      expect((await call(addPattern, 'POST', person, {}, patroon({ geldig_vanaf: day(100), geldig_tot: day(120) }))).status).toBe(201);
    });

    it('changing a pattern onto a day another has is refused too; changing it within its own days is fine', async () => {
      const { person } = buildPerson();
      const a = await call(addPattern, 'POST', person, {}, patroon({ geldig_vanaf: day(0), geldig_tot: day(13) }));
      const b = await call(addPattern, 'POST', person, {}, patroon({ geldig_vanaf: day(20), geldig_tot: day(34) }));
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      const nietZo = await call(editPattern, 'PATCH', person, { patternId: b.json.data.id }, { geldig_vanaf: day(7) });
      expect(nietZo.status).toBe(409);
      expect(nietZo.json.error.code).toBe('PATTERN_OVERLAPS');
      expect((await call(editPattern, 'PATCH', person, { patternId: b.json.data.id }, { geldig_vanaf: day(21) })).status).toBeLessThan(300);
    });
  });
});
