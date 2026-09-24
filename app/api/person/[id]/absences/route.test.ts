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
import { POST } from './route';
import { PATCH } from './[absenceId]/route';

/**
 * The hard rule: an absence is stored only with real calendar dates.
 *
 * The range check ("van" before "tot") is a plain string comparison,
 * because dates live here as YYYY-MM-DD text. That is fine for two real
 * dates and meaningless for anything else: "xx" > "yy" is false, so a pair
 * of non-dates passed the only check there was and landed in the database.
 * Nothing downstream notices - matchSlotsToAbsence compares the same way,
 * finds no slot, and blocks nothing - so the participant sees an absence
 * that quietly protects no days at all.
 */

const createdPersonIds: string[] = [];
const createdAbsenceIds: string[] = [];

function createParticipant(): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op)
     VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`);
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op)
     VALUES (?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, hashToken(`link-${crypto.randomUUID()}`));
  createdPersonIds.push(personId);
  return personId;
}

function cookie(personId: string): string {
  const token = createSessionToken(
    { kind: 'person', personId, sessionVersion: getSessionVersion(personId)! } as never,
    PERSON_SESSION_MAX_AGE_SECONDS
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function post(personId: string, body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/person/${personId}/absences`, {
    method: 'POST',
    headers: { Cookie: cookie(personId), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id: personId }) });
}

function patch(personId: string, absenceId: string, body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/person/${personId}/absences/${absenceId}`, {
    method: 'PATCH',
    headers: { Cookie: cookie(personId), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ id: personId, absenceId }) });
}

afterEach(() => {
  while (createdAbsenceIds.length > 0) {
    const absenceId = createdAbsenceIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_availability WHERE bron_absence_id = ?').run(absenceId);
    db.prepare('DELETE FROM dienstrooster_absence WHERE id = ?').run(absenceId);
  }
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_availability WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_absence WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
});

const NOT_DATES = [
  ['plain nonsense', 'xx', 'yy'],
  ['Dutch day-first notation', '01-03-2027', '05-03-2027'],
  ['a year on its own', '2027', '2027'],
  ['a day that does not exist', '2027-02-30', '2027-03-01'],
  ['a month that does not exist', '2027-13-01', '2027-13-05'],
  ['a timestamp instead of a date', '2027-03-01T10:00:00Z', '2027-03-05T10:00:00Z'],
];

describe('POST /api/person/[id]/absences', () => {
  it.each(NOT_DATES)('refuses %s, and stores nothing', async (_label, van, tot) => {
    const personId = createParticipant();

    const res = await post(personId, { van_datum: van, tot_datum: tot, soort: 'VAKANTIE' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_DATE');

    expect(
      db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_absence WHERE person_id = ?').get(personId)
    ).toEqual({ n: 0 });
  });

  it('accepts a real date range', async () => {
    const personId = createParticipant();

    const res = await post(personId, {
      van_datum: '2027-03-01',
      tot_datum: '2027-03-05',
      soort: 'VAKANTIE',
    });
    expect(res.status).toBe(201);

    const row = db
      .prepare('SELECT id, van_datum, tot_datum FROM dienstrooster_absence WHERE person_id = ?')
      .get(personId) as { id: string; van_datum: string; tot_datum: string };
    createdAbsenceIds.push(row.id);
    expect(row.van_datum).toBe('2027-03-01');
    expect(row.tot_datum).toBe('2027-03-05');
  });

  it('still refuses a range that runs backwards', async () => {
    const personId = createParticipant();
    const res = await post(personId, {
      van_datum: '2027-03-10',
      tot_datum: '2027-03-01',
      soort: 'VAKANTIE',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_RANGE');
  });
});

describe('PATCH /api/person/[id]/absences/[absenceId]', () => {
  async function createValidAbsence(personId: string): Promise<string> {
    await post(personId, { van_datum: '2027-03-01', tot_datum: '2027-03-05', soort: 'VAKANTIE' });
    const row = db
      .prepare('SELECT id FROM dienstrooster_absence WHERE person_id = ?')
      .get(personId) as { id: string };
    createdAbsenceIds.push(row.id);
    return row.id;
  }

  it.each(NOT_DATES)('refuses %s, and leaves the stored dates alone', async (_label, van, tot) => {
    const personId = createParticipant();
    const absenceId = await createValidAbsence(personId);

    const res = await patch(personId, absenceId, { van_datum: van, tot_datum: tot });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_DATE');

    const row = db
      .prepare('SELECT van_datum, tot_datum FROM dienstrooster_absence WHERE id = ?')
      .get(absenceId) as { van_datum: string; tot_datum: string };
    expect(row).toEqual({ van_datum: '2027-03-01', tot_datum: '2027-03-05' });
  });

  it('accepts a real date range', async () => {
    const personId = createParticipant();
    const absenceId = await createValidAbsence(personId);

    const res = await patch(personId, absenceId, { van_datum: '2027-03-02', tot_datum: '2027-03-08' });
    expect(res.status).toBe(200);

    const row = db
      .prepare('SELECT van_datum, tot_datum FROM dienstrooster_absence WHERE id = ?')
      .get(absenceId) as { van_datum: string; tot_datum: string };
    expect(row).toEqual({ van_datum: '2027-03-02', tot_datum: '2027-03-08' });
  });
});

describe('the notitie of an absence', () => {
  it('is capped and must be text, on create and on edit', async () => {
    const personId = createParticipant();
    const base = { van_datum: '2027-03-01', tot_datum: '2027-03-05', soort: 'VAKANTIE' };

    for (const notitie of ['x'.repeat(1001), { tekst: 'geen string' }, ['a']]) {
      const res = await post(personId, { ...base, notitie });
      expect(res.status).toBe(400);
    }
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_absence WHERE person_id = ?').get(personId)
    ).toEqual({ n: 0 });

    expect((await post(personId, { ...base, notitie: '  Zomervakantie  ' })).status).toBe(201);
    const row = db.prepare('SELECT id, notitie FROM dienstrooster_absence WHERE person_id = ?').get(personId) as {
      id: string;
      notitie: string;
    };
    createdAbsenceIds.push(row.id);
    expect(row.notitie).toBe('Zomervakantie');

    expect((await patch(personId, row.id, { notitie: 'y'.repeat(1001) })).status).toBe(400);
    expect(
      (db.prepare('SELECT notitie FROM dienstrooster_absence WHERE id = ?').get(row.id) as { notitie: string }).notitie
    ).toBe('Zomervakantie');
  });
});
