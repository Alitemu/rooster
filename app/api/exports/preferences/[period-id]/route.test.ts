import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET } from './route';

/**
 * The hard rules: every marking of this period is in the export, in
 * words, with why it is there - and nothing from another period, and no
 * neutral day. Only a planner may download it.
 */

const createdPeriodIds: string[] = [];
const createdPoolIds: string[] = [];
const createdRulesetIds: string[] = [];
const createdPersonIds: string[] = [];
const createdShiftTypeIds: string[] = [];

function createPool(): string {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Test ruleset', JSON.stringify({}));
  createdRulesetIds.push(rulesetId);

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Test pool', rulesetId);
  createdPoolIds.push(poolId);
  return poolId;
}

function createPerson(rol: 'DEELNEMER' | 'PLANNER' = 'DEELNEMER'): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`, rol);
  createdPersonIds.push(personId);
  return personId;
}

function createShiftType(poolId: string, teller: 'AVOND' | 'WEEKEND' = 'AVOND'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, ?, ?)`
  ).run(id, poolId, teller === 'AVOND' ? 'Avonddienst' : 'Weekenddienst', teller);
  createdShiftTypeIds.push(id);
  return id;
}

function createPeriod(poolId: string, naam: string, startDatum: string, eindDatum: string): string {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, '2099-01-01T00:00:00Z', 'OPEN', datetime('now'))`
  ).run(periodId, poolId, naam, startDatum, eindDatum);
  createdPeriodIds.push(periodId);
  return periodId;
}

function createSlot(periodId: string, shiftTypeId: string, datum: string, isoWeek = 1): string {
  const slotId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
     VALUES (?, ?, ?, ?, 2027, ?)`
  ).run(slotId, periodId, shiftTypeId, datum, isoWeek);
  return slotId;
}

function mark(
  personId: string,
  slotId: string,
  level: 'ABSOLUUT' | 'LIEVER_NIET' | 'VOORKEUR' | null,
  source: 'MANUAL' | 'PARTTIME' | 'ABSENCE' = 'MANUAL',
  fellow = false
): void {
  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, fellow_blok, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId, level, source, fellow ? 1 : 0);
}

function codenaam(personId: string): string {
  return (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(personId) as { codenaam: string })
    .codenaam;
}

function plannerRequest(periodId: string, personId: string): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId, sessionVersion: getSessionVersion(personId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost/api/exports/preferences/${periodId}`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

async function exportCsv(periodId: string, plannerId: string): Promise<string> {
  const res = await GET(plannerRequest(periodId, plannerId), {
    params: Promise.resolve({ 'period-id': periodId }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare(
      'DELETE FROM dienstrooster_availability WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)'
    ).run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  while (createdShiftTypeIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE id = ?').run(createdShiftTypeIds.pop()!);
  }
  while (createdPersonIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(createdPersonIds.pop()!);
  }
  while (createdPoolIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(createdPoolIds.pop()!);
  }
  while (createdRulesetIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(createdRulesetIds.pop()!);
  }
});

describe('GET /api/exports/preferences/[period-id]', () => {
  it('lists every marking of the period in words, with its reason', async () => {
    const poolId = createPool();
    const avond = createShiftType(poolId, 'AVOND');
    const weekend = createShiftType(poolId, 'WEEKEND');
    const planner = createPerson('PLANNER');
    const a = createPerson();
    const b = createPerson();
    const periodId = createPeriod(poolId, 'Voorjaar 2027', '2027-01-04', '2027-01-17');

    const maandag = createSlot(periodId, avond, '2027-01-04', 1);
    const dinsdag = createSlot(periodId, avond, '2027-01-05', 1);
    const zaterdag = createSlot(periodId, weekend, '2027-01-09', 1);
    const woensdag = createSlot(periodId, avond, '2027-01-13', 2);
    const donderdag = createSlot(periodId, avond, '2027-01-14', 2);

    mark(a, maandag, 'ABSOLUUT', 'PARTTIME');
    mark(a, dinsdag, 'LIEVER_NIET');
    mark(a, zaterdag, 'ABSOLUUT', 'MANUAL', true);
    mark(b, woensdag, 'VOORKEUR');
    mark(b, donderdag, 'ABSOLUUT', 'ABSENCE');

    const lines = (await exportCsv(periodId, planner)).split('\n');
    expect(lines[0]).toBe('Codenaam,Datum,Dag,Week,Dienst,Keuze,Reden');
    const ca = codenaam(a);
    const cb = codenaam(b);
    expect(lines).toContain(`"${ca}","2027-01-04","maandag",1,"avonddienst","geblokkeerd","parttime"`);
    expect(lines).toContain(`"${ca}","2027-01-05","dinsdag",1,"avonddienst","liever niet","handmatig"`);
    expect(lines).toContain(`"${ca}","2027-01-09","zaterdag",1,"weekenddienst","geblokkeerd","fellow"`);
    expect(lines).toContain(`"${cb}","2027-01-13","woensdag",2,"avonddienst","voorkeur","handmatig"`);
    expect(lines).toContain(`"${cb}","2027-01-14","donderdag",2,"avonddienst","geblokkeerd","afwezig"`);
    expect(lines).toHaveLength(6);
  });

  it('leaves out neutral days and other periods', async () => {
    const poolId = createPool();
    const avond = createShiftType(poolId);
    const planner = createPerson('PLANNER');
    const person = createPerson();
    const periodA = createPeriod(poolId, 'Periode A', '2027-01-04', '2027-01-17');
    const periodB = createPeriod(poolId, 'Periode B', '2027-02-01', '2027-02-14');

    mark(person, createSlot(periodA, avond, '2027-01-05'), null);
    mark(person, createSlot(periodB, avond, '2027-02-02'), 'ABSOLUUT');

    const lines = (await exportCsv(periodA, planner)).split('\n');
    expect(lines).toHaveLength(1);
  });

  it('is refused to a participant', async () => {
    const poolId = createPool();
    const person = createPerson();
    const periodId = createPeriod(poolId, 'Periode', '2027-01-04', '2027-01-17');

    const res = await GET(plannerRequest(periodId, person), {
      params: Promise.resolve({ 'period-id': periodId }),
    });
    expect(res.status).toBe(401);
  });
});
