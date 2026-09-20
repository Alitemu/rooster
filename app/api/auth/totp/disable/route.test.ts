import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashPassword, generateTOTPSecret } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { clearRateLimit } from '@/lib/rateLimit';
import { POST } from './route';

/**
 * The hard rule: turning 2FA off is the one recovery path for a lost
 * authenticator app, so it must ask for the password only - never a fresh
 * TOTP code, which is exactly the thing that can no longer be produced.
 */

const PASSWORD = 'Wachtwoord1!';
const createdPersonIds: string[] = [];

async function createStaff(enrolled: boolean): Promise<string> {
  const personId = crypto.randomUUID();
  const totpSecret = enrolled ? generateTOTPSecret('Test').secret : null;
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, totp_secret, aangemaakt_op)
     VALUES (?, ?, 'PLANNER', 1, ?, ?, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`, await hashPassword(PASSWORD), totpSecret);
  createdPersonIds.push(personId);
  return personId;
}

function sessionCookie(personId: string): string {
  return createSessionToken(
    { kind: 'staff', personId, sessionVersion: getSessionVersion(personId)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
}

function request(cookie: string | undefined, body: unknown): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = `${SESSION_COOKIE_NAME}=${cookie}`;
  return new NextRequest('http://localhost/api/auth/totp/disable', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    clearRateLimit(`totp-disable:${personId}`);
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
});

describe('POST /api/auth/totp/disable', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await POST(request(undefined, { wachtwoord: PASSWORD }));
    expect(res.status).toBe(401);
  });

  it('rejects the wrong password, and leaves totp_secret untouched', async () => {
    const personId = await createStaff(true);
    const before = db.prepare('SELECT totp_secret FROM dienstrooster_person WHERE id = ?').get(personId);

    const res = await POST(request(sessionCookie(personId), { wachtwoord: 'verkeerd-wachtwoord' }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('INVALID_PASSWORD');

    expect(db.prepare('SELECT totp_secret FROM dienstrooster_person WHERE id = ?').get(personId)).toEqual(before);
  });

  it('never asks for a TOTP code - the password alone is the whole recovery path', async () => {
    const personId = await createStaff(true);
    // No totpCode field in the request body at all - if this route ever
    // required one, this call could never succeed, and that is exactly the
    // scenario ("I no longer have a code to give") this route is for.
    const res = await POST(request(sessionCookie(personId), { wachtwoord: PASSWORD }));
    expect(res.status).toBe(200);

    const row = db.prepare('SELECT totp_secret FROM dienstrooster_person WHERE id = ?').get(personId) as {
      totp_secret: string | null;
    };
    expect(row.totp_secret).toBeNull();
  });

  it('refuses to disable when nothing is enrolled', async () => {
    const personId = await createStaff(false);
    const res = await POST(request(sessionCookie(personId), { wachtwoord: PASSWORD }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('NOT_ENROLLED');
  });

  it('records the change in the audit trail without any secret material', async () => {
    const personId = await createStaff(true);
    await POST(request(sessionCookie(personId), { wachtwoord: PASSWORD }));

    const row = db
      .prepare(
        `SELECT actie, nieuw_json FROM dienstrooster_audit_log
         WHERE actor_id = ? AND entiteit = 'person' ORDER BY tijdstip DESC LIMIT 1`
      )
      .get(personId) as { actie: string; nieuw_json: string };

    expect(row.actie).toBe('UPDATE');
    expect(JSON.parse(row.nieuw_json)).toEqual({ wijziging: 'totp_uitgeschakeld' });
  });
});
