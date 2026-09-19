import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { getAuthContextFromRequest } from '@/lib/auth-context';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  PERSON_SESSION_MAX_AGE_SECONDS,
  STAFF_SESSION_MAX_AGE_SECONDS,
} from '@/lib/session';
import { getSessionVersion, revokeAllSessions } from './sessionVersion';

/**
 * The hard rule: a session token minted before revocation is refused
 * afterwards, for both kinds of session.
 *
 * This is the property the whole mechanism exists for. Session cookies are
 * self-contained, so before this, "log out" reached only the browser that
 * asked and a copied cookie stayed valid for up to 30 days. A test that
 * merely showed a fresh cookie working would not have noticed that.
 */

const createdPersonIds: string[] = [];

function createPerson(rol: 'DEELNEMER' | 'PLANNER' = 'DEELNEMER'): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`, rol);
  createdPersonIds.push(personId);

  if (rol === 'DEELNEMER') {
    // A DEELNEMER needs a live access link for their session to be
    // accepted at all (lib/auth-context.ts).
    db.prepare(
      `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op)
       VALUES (?, ?, ?, datetime('now'))`
    ).run(crypto.randomUUID(), personId, hashToken(`link-${crypto.randomUUID()}`));
  }
  return personId;
}

function requestWithToken(token: string): NextRequest {
  return new NextRequest('http://localhost/api/periods', {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

/** A cookie exactly as the login routes would have issued it, right now. */
function currentSession(personId: string, kind: 'person' | 'staff'): string {
  const maxAge = kind === 'staff' ? STAFF_SESSION_MAX_AGE_SECONDS : PERSON_SESSION_MAX_AGE_SECONDS;
  return createSessionToken(
    { kind, personId, sessionVersion: getSessionVersion(personId)! } as never,
    maxAge
  );
}

afterEach(() => {
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
});

describe('session revocation', () => {
  it('starts every person at version 1', () => {
    expect(getSessionVersion(createPerson())).toBe(1);
  });

  it('returns null for a person who no longer exists', () => {
    expect(getSessionVersion(crypto.randomUUID())).toBeNull();
  });

  it('refuses a staff cookie issued before revocation', () => {
    const planner = createPerson('PLANNER');
    const cookie = currentSession(planner, 'staff');
    expect(getAuthContextFromRequest(requestWithToken(cookie))).not.toBeNull();

    revokeAllSessions(planner);

    expect(getAuthContextFromRequest(requestWithToken(cookie))).toBeNull();
  });

  it('refuses a participant cookie issued before revocation, link still live', () => {
    const participant = createPerson();
    const cookie = currentSession(participant, 'person');
    expect(getAuthContextFromRequest(requestWithToken(cookie))).not.toBeNull();

    revokeAllSessions(participant);

    // The access link was never touched - only the version moved. Without
    // the version check this cookie would still be accepted for 30 days.
    const liveLinks = db
      .prepare(
        `SELECT COUNT(*) AS c FROM dienstrooster_person_access_link
         WHERE person_id = ? AND ingetrokken_op IS NULL`
      )
      .get(participant) as { c: number };
    expect(liveLinks.c).toBe(1);

    expect(getAuthContextFromRequest(requestWithToken(cookie))).toBeNull();
  });

  it('lets a cookie issued after revocation straight through', () => {
    const planner = createPerson('PLANNER');
    revokeAllSessions(planner);

    expect(getAuthContextFromRequest(requestWithToken(currentSession(planner, 'staff')))).not.toBeNull();
  });

  it('revokes only the person named, never everyone', () => {
    const one = createPerson('PLANNER');
    const other = createPerson('PLANNER');
    const otherCookie = currentSession(other, 'staff');

    revokeAllSessions(one);

    expect(getAuthContextFromRequest(requestWithToken(otherCookie))).not.toBeNull();
  });

  it('refuses a token from before the column existed, which carries no version', () => {
    const planner = createPerson('PLANNER');
    const legacy = createSessionToken(
      { kind: 'staff', personId: planner } as never,
      STAFF_SESSION_MAX_AGE_SECONDS
    );

    expect(getAuthContextFromRequest(requestWithToken(legacy))).toBeNull();
  });

  it('raises the version by exactly one and reports the new value', () => {
    const planner = createPerson('PLANNER');
    expect(revokeAllSessions(planner)).toBe(2);
    expect(revokeAllSessions(planner)).toBe(3);
    expect(getSessionVersion(planner)).toBe(3);
  });

  it('throws rather than silently doing nothing for an unknown person', () => {
    expect(() => revokeAllSessions(crypto.randomUUID())).toThrow();
  });
});
