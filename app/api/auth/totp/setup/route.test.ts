import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashPassword, hashToken } from '@/lib/auth';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  STAFF_SESSION_MAX_AGE_SECONDS,
  PERSON_SESSION_MAX_AGE_SECONDS,
  verifyPayload,
} from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { clearRateLimit } from '@/lib/rateLimit';
import { POST } from './route';
import type { TotpSetupPayload } from './route';

/**
 * The hard rules for beginning TOTP enrollment:
 *   1. only an authenticated staff session may start it;
 *   2. nothing is persisted yet - the secret only lives in the signed setup
 *      token, so a staff member who never confirms is left exactly as
 *      before;
 *   3. the returned QR image actually encodes the same secret the setup
 *      token carries, so what gets scanned is what gets confirmed.
 */

const createdPersonIds: string[] = [];

async function createStaff(): Promise<string> {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op)
     VALUES (?, ?, 'PLANNER', 1, ?, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`, await hashPassword('Wachtwoord1!'));
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

function request(cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = `${SESSION_COOKIE_NAME}=${cookie}`;
  return new NextRequest('http://localhost/api/auth/totp/setup', { method: 'POST', headers });
}

afterEach(() => {
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    clearRateLimit(`totp-setup:${personId}`);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
});

describe('POST /api/auth/totp/setup', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await POST(request());
    expect(res.status).toBe(401);
  });

  it('rejects a participant session', async () => {
    const personId = createParticipant();
    const res = await POST(request(sessionCookie(personId, 'person')));
    expect(res.status).toBe(401);
  });

  it('returns a setup token, a QR image, and the bare secret for a staff session', async () => {
    const personId = await createStaff();
    const res = await POST(request(sessionCookie(personId)));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.setup_token).toBeTruthy();
    expect(body.data.secret).toMatch(/^[A-Z2-7]+$/); // base32
    expect(body.data.qr_code_image).toMatch(/^data:image\/png;base64,/);
    expect(body.data.qr_code).toContain(body.data.secret);
  });

  it('persists nothing - the account has no totp_secret until confirm is called', async () => {
    const personId = await createStaff();
    await POST(request(sessionCookie(personId)));

    const row = db.prepare('SELECT totp_secret FROM dienstrooster_person WHERE id = ?').get(personId) as {
      totp_secret: string | null;
    };
    expect(row.totp_secret).toBeNull();
  });

  it('signs the setup token to exactly this account and this secret', async () => {
    const personId = await createStaff();
    const res = await POST(request(sessionCookie(personId)));
    const body = await res.json();

    const payload = verifyPayload<TotpSetupPayload>(body.data.setup_token);
    expect(payload?.kind).toBe('totp-setup');
    expect(payload?.personId).toBe(personId);
    expect(payload?.secret).toBe(body.data.secret);
  });
});
