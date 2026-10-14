import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET } from './route';

/**
 * The rule: a participant's list of notices takes `limit` as a number of
 * notices, from 1 to 200 - whatever the address bar says (audit 11).
 * `limit=abc` became NaN and the query a 500; `limit=-1` became SQLite's
 * "no limit".
 */

let personId = '';
const notificationIds: string[] = [];

function get(query: string) {
  const token = createSessionToken(
    { kind: 'person', personId, sessionVersion: getSessionVersion(personId)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return GET(
    new NextRequest(`http://localhost/api/person/${personId}/notifications${query}`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }),
    { params: Promise.resolve({ id: personId }) }
  );
}

beforeAll(() => {
  personId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, ?)`).run(
    personId,
    `Melding-${personId.slice(0, 6)}`,
    new Date().toISOString()
  );
  // A participant's session holds while they have a link that isn't revoked.
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op) VALUES (?, ?, ?, ?)`
  ).run(crypto.randomUUID(), personId, crypto.randomUUID(), new Date().toISOString());
  for (let i = 0; i < 3; i++) {
    const id = crypto.randomUUID();
    notificationIds.push(id);
    db.prepare(
      `INSERT INTO dienstrooster_notification (id, person_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
       VALUES (?, ?, 'TOEWIJZING', ?, 'Tekst', 0, ?)`
    ).run(id, personId, `Melding ${i}`, new Date(Date.UTC(2030, 0, 1 + i)).toISOString());
  }
});

afterAll(() => {
  for (const id of notificationIds) db.prepare('DELETE FROM dienstrooster_notification WHERE id = ?').run(id);
  db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
  db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
});

const count = async (query: string) => {
  const res = await get(query);
  expect(res.status, query).toBe(200);
  const body = await res.json();
  return (body.data.notifications ?? body.data).length as number;
};

describe('GET /api/person/[id]/notifications', () => {
  it('takes a number from 1 to 200 and anything else as the default', async () => {
    expect(await count('')).toBe(3);
    expect(await count('?limit=2')).toBe(2);
    expect(await count('?limit=abc')).toBe(3);
    expect(await count('?limit=-1')).toBe(3);
    expect(await count('?limit=0')).toBe(3);
    expect(await count('?limit=1e9')).toBe(3);
  });
});
