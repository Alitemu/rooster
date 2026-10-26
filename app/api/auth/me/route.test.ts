import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  STAFF_SESSION_MAX_AGE_SECONDS,
  PERSON_SESSION_MAX_AGE_SECONDS,
} from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET } from './route';

/**
 * Who am I: the session says who is logged in, in what role, and for staff
 * whether a new password has to come first. Two-step verification no longer
 * exists (0.805.0): nothing about it is reported any more.
 */

const createdPersonIds: string[] = [];

function createStaff(): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op)
     VALUES (?, ?, 'PLANNER', 1, 'x', datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`);
  createdPersonIds.push(personId);
  return personId;
}

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

function request(personId?: string, kind: 'staff' | 'person' = 'staff'): NextRequest {
  const headers: Record<string, string> = {};
  if (personId) {
    const token = createSessionToken(
      { kind, personId, sessionVersion: getSessionVersion(personId)! } as never,
      kind === 'staff' ? STAFF_SESSION_MAX_AGE_SECONDS : PERSON_SESSION_MAX_AGE_SECONDS
    );
    headers['Cookie'] = `${SESSION_COOKIE_NAME}=${token}`;
  }
  return new NextRequest('http://localhost/api/auth/me', { headers });
}

afterEach(() => {
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
});

describe('GET /api/auth/me', () => {
  it('reports unauthenticated with no session', async () => {
    const res = await GET(request());
    const body = await res.json();
    expect(body.data.authenticated).toBe(false);
  });

  it('reports the role of staff and says nothing about two-step verification', async () => {
    const personId = createStaff();
    const body = await (await GET(request(personId))).json();
    expect(body.data).toMatchObject({ authenticated: true, role: 'PLANNER' });
    expect(body.data).not.toHaveProperty('totp_enrolled');
  });

  it('reports a participant as a participant', async () => {
    const personId = createParticipant();
    const body = await (await GET(request(personId, 'person'))).json();
    expect(body.data).toMatchObject({ authenticated: true, role: 'DEELNEMER' });
    expect(body.data).not.toHaveProperty('totp_enrolled');
  });
});
