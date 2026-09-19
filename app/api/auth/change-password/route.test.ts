import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashPassword, verifyPassword, hashToken } from '@/lib/auth';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  STAFF_SESSION_MAX_AGE_SECONDS,
  PERSON_SESSION_MAX_AGE_SECONDS,
} from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { getAuthContextFromRequest } from '@/lib/auth-context';
import { clearRateLimit } from '@/lib/rateLimit';
import { POST } from './route';

/**
 * The hard rules for changing your own password:
 *   1. knowing the current password is required, so an unattended logged-in
 *      session cannot be used to lock the real planner out;
 *   2. every other session is revoked, so a change made after a suspected
 *      leak actually ends the leaked session;
 *   3. the browser that made the change stays signed in;
 *   4. only staff can call it at all.
 */

const OLD_PASSWORD = 'OudWachtwoord1!';
const NEW_PASSWORD = 'NieuwWachtwoord2!';

const createdPersonIds: string[] = [];

async function createStaff(password: string | null = OLD_PASSWORD): Promise<string> {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op)
     VALUES (?, ?, 'PLANNER', 1, ?, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`, password === null ? null : await hashPassword(password));
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

function sessionCookie(personId: string, kind: 'staff' | 'person' = 'staff'): string {
  return createSessionToken(
    { kind, personId, sessionVersion: getSessionVersion(personId)! } as never,
    kind === 'staff' ? STAFF_SESSION_MAX_AGE_SECONDS : PERSON_SESSION_MAX_AGE_SECONDS
  );
}

function post(cookie: string | null, body: unknown): Promise<Response> {
  return POST(
    new NextRequest('http://localhost/api/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {}),
      },
      body: JSON.stringify(body),
    })
  ) as unknown as Promise<Response>;
}

function storedHash(personId: string): string | null {
  const row = db
    .prepare('SELECT wachtwoord_hash FROM dienstrooster_person WHERE id = ?')
    .get(personId) as { wachtwoord_hash: string | null };
  return row.wachtwoord_hash;
}

/** The cookie the response set, so it can be replayed as a real request. */
function issuedCookie(res: Response): string | undefined {
  const setCookies = res.headers.getSetCookie();
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const [name, value] = pair.split('=');
    if (name === SESSION_COOKIE_NAME) return value;
  }
  return undefined;
}

function accepts(cookie: string): boolean {
  return (
    getAuthContextFromRequest(
      new NextRequest('http://localhost/api/periods', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      })
    ) !== null
  );
}

afterEach(() => {
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    clearRateLimit(`change-password:${personId}`);
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
});

describe('POST /api/auth/change-password', () => {
  it('changes the password when the current one is given', async () => {
    const planner = await createStaff();
    const res = await post(sessionCookie(planner), {
      huidig_wachtwoord: OLD_PASSWORD,
      nieuw_wachtwoord: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(await verifyPassword(NEW_PASSWORD, storedHash(planner)!)).toBe(true);
  });

  it('refuses a wrong current password and leaves the old one in place', async () => {
    const planner = await createStaff();
    const before = storedHash(planner);

    const res = await post(sessionCookie(planner), {
      huidig_wachtwoord: 'NietHetWachtwoord1!',
      nieuw_wachtwoord: NEW_PASSWORD,
    });

    expect(res.status).toBe(401);
    expect(storedHash(planner)).toBe(before);
  });

  it('refuses an account that has no password yet, rather than setting one', async () => {
    // /api/auth/first-run-setup owns that claim, and it requires the setup
    // token. This route must not become a second way in.
    const planner = await createStaff(null);

    const res = await post(sessionCookie(planner), {
      huidig_wachtwoord: 'WatDanOok1!',
      nieuw_wachtwoord: NEW_PASSWORD,
    });

    expect(res.status).toBe(401);
    expect(storedHash(planner)).toBeNull();
  });

  it('kills every other session, and keeps the browser that made the change', async () => {
    const planner = await createStaff();
    const otherDevice = sessionCookie(planner);
    const thisBrowser = sessionCookie(planner);
    expect(accepts(otherDevice)).toBe(true);

    const res = await post(thisBrowser, {
      huidig_wachtwoord: OLD_PASSWORD,
      nieuw_wachtwoord: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);

    expect(accepts(otherDevice)).toBe(false);
    expect(accepts(thisBrowser)).toBe(false);

    const replacement = issuedCookie(res);
    expect(replacement).toBeDefined();
    expect(accepts(replacement!)).toBe(true);
  });

  it('rejects a weak new password and changes nothing', async () => {
    const planner = await createStaff();
    const before = storedHash(planner);

    const res = await post(sessionCookie(planner), {
      huidig_wachtwoord: OLD_PASSWORD,
      nieuw_wachtwoord: 'kort',
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('WEAK_PASSWORD');
    expect(storedHash(planner)).toBe(before);
  });

  it('rejects re-submitting the same password', async () => {
    const planner = await createStaff();
    const res = await post(sessionCookie(planner), {
      huidig_wachtwoord: OLD_PASSWORD,
      nieuw_wachtwoord: OLD_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('PASSWORD_UNCHANGED');
  });

  it('is closed to participants', async () => {
    const participant = createParticipant();
    const res = await post(sessionCookie(participant, 'person'), {
      huidig_wachtwoord: OLD_PASSWORD,
      nieuw_wachtwoord: NEW_PASSWORD,
    });

    expect(res.status).toBe(401);
  });

  it('is closed to callers with no session at all', async () => {
    const res = await post(null, {
      huidig_wachtwoord: OLD_PASSWORD,
      nieuw_wachtwoord: NEW_PASSWORD,
    });

    expect(res.status).toBe(401);
  });

  it('records the change in the audit trail without any password material', async () => {
    const planner = await createStaff();
    await post(sessionCookie(planner), {
      huidig_wachtwoord: OLD_PASSWORD,
      nieuw_wachtwoord: NEW_PASSWORD,
    });

    const entry = db
      .prepare('SELECT actie, nieuw_json FROM dienstrooster_audit_log WHERE actor_id = ?')
      .get(planner) as { actie: string; nieuw_json: string };

    expect(entry.actie).toBe('UPDATE');
    expect(entry.nieuw_json).not.toContain(OLD_PASSWORD);
    expect(entry.nieuw_json).not.toContain(NEW_PASSWORD);
    expect(JSON.parse(entry.nieuw_json).wijziging).toBe('wachtwoord');
  });

  it('stops guessing the current password after ten failures', async () => {
    const planner = await createStaff();
    const cookie = sessionCookie(planner);

    for (let i = 0; i < 10; i++) {
      const res = await post(cookie, {
        huidig_wachtwoord: `Fout${i}Wachtwoord!`,
        nieuw_wachtwoord: NEW_PASSWORD,
      });
      expect(res.status).toBe(401);
    }

    const blocked = await post(cookie, {
      huidig_wachtwoord: OLD_PASSWORD,
      nieuw_wachtwoord: NEW_PASSWORD,
    });
    expect(blocked.status).toBe(429);
    expect(await verifyPassword(OLD_PASSWORD, storedHash(planner)!)).toBe(true);
  });
});
