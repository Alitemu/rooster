import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, PERSON_SESSION_MAX_AGE_SECONDS, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { PATCH as markSlot } from './preferences/slot/[slotId]/route';
import { PUT as parttimeCheck } from './parttime-check/route';
import { POST as submit } from './preferences/submission/route';
import { POST as addAbsence } from './absences/route';
import { PATCH as editAbsence, DELETE as deleteAbsence } from './absences/[absenceId]/route';
import { POST as addPattern } from './parttime-patterns/route';
import { PATCH as editPattern, DELETE as deletePattern } from './parttime-patterns/[patternId]/route';

/**
 * The rule: a planner changing a participant's own input for them is in
 * the audit log - one row per action, naming the planner - and the
 * participant's own input is not (audit 9).
 */

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

const cookieOf = (kind: 'person' | 'staff', personId: string) =>
  `${SESSION_COOKIE_NAME}=${createSessionToken(
    { kind, personId, sessionVersion: getSessionVersion(personId)! } as never,
    kind === 'staff' ? STAFF_SESSION_MAX_AGE_SECONDS : PERSON_SESSION_MAX_AGE_SECONDS
  )}`;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, method: string, cookie: string, params: Record<string, string>, body: unknown) {
  const res = await (handler as Handler)(
    new NextRequest('http://localhost/api/person/x', { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: ids.person, ...params }) }
  );
  return res.status;
}

/** Like call(), with the answer: the new rows are needed to change and delete them. */
async function callJson(handler: unknown, method: string, cookie: string, params: Record<string, string>, body?: unknown) {
  const res = await (handler as Handler)(
    new NextRequest('http://localhost/api/person/x', {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ids.person, ...params }) }
  );
  return { status: res.status, body: await res.json() };
}

const auditRows = () =>
  db.prepare(`SELECT actor_id, nieuw_json FROM dienstrooster_audit_log WHERE entiteit_id = ? ORDER BY rowid`).all(ids.person) as Array<{
    actor_id: string;
    nieuw_json: string;
  }>;

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Namens', config_json: '{}', aangemaakt_op: now });
  const pool = insert('dienstrooster_pool', { naam: 'Namens', ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: pool, naam: 'Avond', teller: 'AVOND' });
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: 'Namens',
    start_datum: '2099-03-02',
    eind_datum: '2099-03-08',
    deadline: '2099-01-01T00:00',
    status: 'OPEN',
    bevroren_ruleset_json: '{"windowWeeks":2}',
    aangemaakt_op: now,
  });
  ids.slot = insert('dienstrooster_shift_slot', { period_id: ids.period, shift_type_id: avond, datum: '2099-03-03', iso_jaar: 2099, iso_week: 10, is_feestdag: 0, benodigd_aantal_personen: 1 });
  ids.person = insert('dienstrooster_person', { codenaam: `Namens-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  insert('dienstrooster_pool_membership', { person_id: ids.person, pool_id: pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  insert('dienstrooster_person_access_link', { person_id: ids.person, token_hash: crypto.randomBytes(32).toString('hex'), geldt_voor_periode_id: ids.period, aangemaakt_op: now });
  ids.planner = insert('dienstrooster_person', { codenaam: `Namens-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('a planner acting for someone is logged, the person acting for themselves is not', () => {
  it('the participant: a preference, the part-time check and the hand-in, nothing logged', async () => {
    const own = cookieOf('person', ids.person);
    expect(await call(markSlot, 'PATCH', own, { slotId: ids.slot }, { level: 'VOORKEUR' })).toBe(200);
    expect(await call(parttimeCheck, 'PUT', own, {}, { period_id: ids.period, gecontroleerd: true })).toBe(200);
    expect(await call(submit, 'POST', own, {}, { period_id: ids.period })).toBe(200);
    expect(auditRows()).toEqual([]);
  });

  it('the planner: the same three, one row each, naming the planner', async () => {
    const planner = cookieOf('staff', ids.planner);
    expect(await call(markSlot, 'PATCH', planner, { slotId: ids.slot }, { level: 'ABSOLUUT' })).toBe(200);
    expect(await call(parttimeCheck, 'PUT', planner, {}, { period_id: ids.period, gecontroleerd: true })).toBe(200);
    expect(await call(submit, 'POST', planner, {}, { period_id: ids.period })).toBe(200);
    const rows = auditRows();
    expect(rows.map((r) => r.actor_id)).toEqual([ids.planner, ids.planner, ids.planner]);
    expect(rows.map((r) => JSON.parse(r.nieuw_json).wijziging)).toEqual([
      'voorkeur gewijzigd door planner',
      'deeltijd gecontroleerd door planner',
      'ingediend door planner',
    ]);
  });

  // The absence and part-time routes had no row about the planner at all (the audit of 0.111.0); a sweep only
  // sees that the call is in the source, so this one watches the row itself: written, naming the planner.
  it.each([['participant', false], ['planner', true]] as const)(
    'absences and part-time patterns, by the %s',
    async (_wie, isPlanner) => {
      const cookie = isPlanner ? cookieOf('staff', ids.planner) : cookieOf('person', ids.person);
      const voor = auditRows().length;

      const afw = await callJson(addAbsence, 'POST', cookie, {}, { van_datum: '2099-03-04', tot_datum: '2099-03-05', soort: 'VAKANTIE' });
      expect(afw.status, JSON.stringify(afw.body)).toBe(201);
      const absenceId = afw.body.data.id as string;
      const afwPatch = await callJson(editAbsence, 'PATCH', cookie, { absenceId }, { van_datum: '2099-03-04', tot_datum: '2099-03-06' });
      expect(afwPatch.status, JSON.stringify(afwPatch.body)).toBe(200);
      expect((await callJson(deleteAbsence, 'DELETE', cookie, { absenceId })).status).toBe(200);

      const pat = await callJson(addPattern, 'POST', cookie, {}, { weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2099-03-02', geldig_tot: '2099-03-08' });
      expect(pat.status, JSON.stringify(pat.body)).toBe(201);
      const patternId = pat.body.data.id as string;
      const patPatch = await callJson(editPattern, 'PATCH', cookie, { patternId }, { weekdag: 'DI' });
      expect(patPatch.status, JSON.stringify(patPatch.body)).toBe(200);
      expect((await callJson(deletePattern, 'DELETE', cookie, { patternId })).status).toBe(200);

      const nieuw = auditRows().slice(voor);
      if (!isPlanner) {
        expect(nieuw).toEqual([]);
        return;
      }
      expect(nieuw.map((r) => r.actor_id)).toEqual(Array(6).fill(ids.planner));
      expect(nieuw.map((r) => JSON.parse(r.nieuw_json).wijziging)).toEqual([
        'afwezigheid toegevoegd door planner',
        'afwezigheid gewijzigd door planner',
        'afwezigheid verwijderd door planner',
        'deeltijdpatroon toegevoegd door planner',
        'deeltijdpatroon gewijzigd door planner',
        'deeltijdpatroon verwijderd door planner',
      ]);
    }
  );
});
