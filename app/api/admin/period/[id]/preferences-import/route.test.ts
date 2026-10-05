import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { generateSlotsForPeriod } from '@/lib/slotGeneration';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { parseCsv } from '@/lib/csv';
import { POST } from './route';
import { GET as exportPreferences } from '../../../../exports/preferences/[period-id]/route';

/**
 * The rules: only a beheerder imports; checking changes nothing; the
 * overview read back unchanged changes nothing; hand markings follow the
 * file, while part-time, absence and fellow blocks are never touched; a
 * file with problems is refused whole; a built roster is left alone.
 */

interface Fixture {
  poolId: string;
  rulesetId: string;
  periodId: string;
  people: Array<{ id: string; codenaam: string }>;
  slots: Array<{ id: string; datum: string }>;
  admin: string;
  planner: string;
}

const fixtures: Fixture[] = [];

function staff(rol: 'ADMIN' | 'PLANNER'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(id, `S-${id.slice(0, 8)}`, rol);
  return id;
}

function createFixture(): Fixture {
  const rulesetId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'Test', '{}', datetime('now'))`).run(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Test pool', ?, datetime('now'))`).run(poolId, rulesetId);
  const shiftTypeId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`).run(shiftTypeId, poolId);

  const people = [0, 1].map(() => {
    const id = crypto.randomUUID();
    const codenaam = `Imp-${id.slice(0, 8)}`;
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(id, codenaam);
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`
    ).run(crypto.randomUUID(), id, poolId);
    return { id, codenaam };
  });

  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'Importtest', '2027-01-04', '2027-01-10', '2099-01-01T00:00', 'OPEN', '{}', datetime('now'))`
  ).run(periodId, poolId);
  const insert = db.prepare(
    `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id, is_feestdag, feestdag_groep, benodigd_aantal_personen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  const slots = generateSlotsForPeriod({ startDate: '2027-01-04', endDate: '2027-01-10', shiftTypes: ['AVOND'] }).map((s) => {
    const id = crypto.randomUUID();
    insert.run(id, periodId, shiftTypeId, s.datum, s.iso_jaar, s.iso_week, s.weekend_id || null, s.is_feestdag ? 1 : 0, s.feestdag_groep);
    return { id, datum: s.datum };
  });

  const f = { poolId, rulesetId, periodId, people, slots, admin: staff('ADMIN'), planner: staff('PLANNER') };
  fixtures.push(f);
  return f;
}

function mark(personId: string, slotId: string, level: string, source: 'MANUAL' | 'PARTTIME' = 'MANUAL') {
  db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op) VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, slotId, level, source);
}

function markings(f: Fixture): Record<string, string> {
  const rows = db
    .prepare(
      `SELECT p.codenaam, s.datum, a.blocking_level, a.source FROM dienstrooster_availability a
       JOIN dienstrooster_person p ON p.id = a.person_id JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       WHERE s.period_id = ?`
    )
    .all(f.periodId) as Array<{ codenaam: string; datum: string; blocking_level: string; source: string }>;
  return Object.fromEntries(rows.map((r) => [`${r.codenaam}|${r.datum}`, `${r.blocking_level}/${r.source}`]));
}

function req(url: string, actorId: string, method = 'GET', body?: unknown) {
  const token = createSessionToken(
    { kind: 'staff', personId: actorId, sessionVersion: getSessionVersion(actorId)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function exported(f: Fixture): Promise<string> {
  const res = await exportPreferences(req(`/api/exports/preferences/${f.periodId}`, f.admin), {
    params: Promise.resolve({ 'period-id': f.periodId }),
  });
  return res.text();
}

async function importCsv(f: Fixture, csv: string, toepassen: boolean, actor = f.admin) {
  const res = await POST(req(`/api/admin/period/${f.periodId}/preferences-import`, actor, 'POST', { csv, toepassen }), {
    params: Promise.resolve({ id: f.periodId }),
  });
  return { status: res.status, body: await res.json() };
}

/** The exported grid with one cell replaced, written back with ";". */
function edit(csv: string, changes: Array<[datum: string, codenaam: string, value: string]>): string {
  const rows = parseCsv(csv.replace(/^﻿/, ''), ';');
  for (const [datum, codenaam, value] of changes) {
    const col = rows[0].indexOf(codenaam);
    const row = rows.find((r) => r[0] === datum)!;
    row[col] = value;
  }
  return rows.map((r) => r.join(';')).join('\r\n');
}

afterEach(() => {
  for (const f of fixtures.splice(0)) {
    const ids = [...f.people.map((p) => p.id), f.admin, f.planner];
    db.prepare(`DELETE FROM dienstrooster_availability WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)`).run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_submission WHERE schedule_period_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(f.periodId);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(f.poolId);
    for (const id of ids) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(f.poolId);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(f.poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(f.rulesetId);
  }
});

describe('POST /api/admin/period/[id]/preferences-import', () => {
  it('is for a beheerder only', async () => {
    const f = createFixture();
    const csv = await exported(f);
    expect((await importCsv(f, csv, false, f.planner)).status).toBe(401);
    expect((await importCsv(f, csv, false)).status).toBe(200);
  });

  it('changes nothing when the overview is read back unchanged', async () => {
    const f = createFixture();
    const [a, b] = f.people;
    mark(a.id, f.slots[0].id, 'ABSOLUUT');
    mark(b.id, f.slots[1].id, 'LIEVER_NIET', 'PARTTIME');
    const { body } = await importCsv(f, await exported(f), false);
    expect(body.data.wijzigingen).toEqual([]);
    expect(body.data.problemen).toEqual([]);
    expect(body.data.overgeslagen).toBe(1);
  });

  it('sets and clears hand markings, and leaves part-time blocks alone', async () => {
    const f = createFixture();
    const [a, b] = f.people;
    const [d0, d1, d2, d3] = f.slots.map((s) => s.datum);
    mark(a.id, f.slots[0].id, 'ABSOLUUT');
    mark(a.id, f.slots[1].id, 'VOORKEUR');
    mark(b.id, f.slots[2].id, 'ABSOLUUT', 'PARTTIME');
    mark(b.id, f.slots[3].id, 'ABSOLUUT', 'PARTTIME');
    const before = markings(f);

    const csv = edit(await exported(f), [
      [d0, a.codenaam, 'liever niet'], // changed
      [d1, a.codenaam, ''], // cleared
      [d2, a.codenaam, 'Voorkeur'], // new, any case
      [d2, b.codenaam, ''], // empty on a part-time block: stays
      [d3, b.codenaam, 'voorkeur (parttime)'], // automatic cell: skipped
    ]);

    const check = await importCsv(f, csv, false);
    expect(check.body.data.wijzigingen).toHaveLength(3);
    expect(markings(f)).toEqual(before); // checking changes nothing

    const applied = await importCsv(f, csv, true);
    expect(applied.body.data.toegepast).toBe(true);
    expect(markings(f)).toEqual({
      [`${a.codenaam}|${d0}`]: 'LIEVER_NIET/MANUAL',
      [`${a.codenaam}|${d2}`]: 'VOORKEUR/MANUAL',
      [`${b.codenaam}|${d2}`]: 'ABSOLUUT/PARTTIME',
      [`${b.codenaam}|${d3}`]: 'ABSOLUUT/PARTTIME',
    });
  });

  it('reads the dates a Dutch Excel writes when it saves the file', async () => {
    const f = createFixture();
    const [a] = f.people;
    const csv = edit(await exported(f), [[f.slots[0].datum, a.codenaam, 'geblokkeerd']]).replace(/^2027-01-04/m, '4-1-2027');
    const { body } = await importCsv(f, csv, false);
    expect(body.data.problemen).toEqual([]);
    expect(body.data.wijzigingen).toEqual([
      { codenaam: a.codenaam, datum: '2027-01-04', dienst: 'avonddienst', van: 'leeg', naar: 'geblokkeerd' },
    ]);
  });

  it('refuses a file with problems as a whole', async () => {
    const f = createFixture();
    const [a] = f.people;
    let csv = edit(await exported(f), [
      [f.slots[0].datum, a.codenaam, 'geblokkeerd'],
      [f.slots[1].datum, a.codenaam, 'misschien'],
    ]);
    csv = csv.replace(/^(Datum;Dag;Week;Dienst;.*)$/m, '$1;Onbekend-99');
    const check = await importCsv(f, csv, false);
    expect(check.body.data.problemen).toHaveLength(2);
    const applied = await importCsv(f, csv, true);
    expect(applied.status).toBe(400);
    expect(markings(f)).toEqual({});
  });

  it('leaves a period whose roster is built alone', async () => {
    const f = createFixture();
    const csv = await exported(f);
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD' WHERE id = ?`).run(f.periodId);
    expect((await importCsv(f, csv, false)).status).toBe(409);
  });
});
