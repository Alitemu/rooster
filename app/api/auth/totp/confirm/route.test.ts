import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashPassword, generateTOTPCode } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { clearRateLimit } from '@/lib/rateLimit';
import { POST as setupTotp } from '../setup/route';
import { POST as confirmTotp } from './route';
import { POST as staffLogin } from '../../staff-login/route';
import { POST as disableTotp } from '../disable/route';

/**
 * The hard rule this whole feature exists for: enrolling actually changes
 * what staff-login accepts, end to end - not just that the confirm call
 * itself returns 200. lib/auth.test.ts already proves verifyTOTPCode's
 * replay protection in isolation; this proves the route wiring between
 * setup -> confirm -> login (and back out via disable) actually holds
 * together, using a real generated code throughout, not a stub.
 */

const PASSWORD = 'Wachtwoord1!';
const createdPersonIds: string[] = [];

async function createStaff(): Promise<string> {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op)
     VALUES (?, ?, 'PLANNER', 1, ?, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`, await hashPassword(PASSWORD));
  createdPersonIds.push(personId);
  return personId;
}

function sessionCookie(personId: string): string {
  return createSessionToken(
    { kind: 'staff', personId, sessionVersion: getSessionVersion(personId)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
}

function staffRequest(path: string, cookie: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function loginRequest(codenaam: string, password: string, totpCode?: string): NextRequest {
  return new NextRequest('http://localhost/api/auth/staff-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codenaam, password, totpCode }),
  });
}

/** Runs setup, then confirms with a freshly generated real code. Returns the codenaam for login tests. */
async function enroll(personId: string): Promise<string> {
  const setupRes = await setupTotp(staffRequest('/api/auth/totp/setup', sessionCookie(personId)));
  const setupBody = await setupRes.json();
  const code = generateTOTPCode(setupBody.data.secret);

  const confirmRes = await confirmTotp(
    staffRequest('/api/auth/totp/confirm', sessionCookie(personId), {
      setup_token: setupBody.data.setup_token,
      code,
    })
  );
  expect(confirmRes.status).toBe(200);

  return (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(personId) as { codenaam: string })
    .codenaam;
}

afterEach(() => {
  // Shared across every test in this file (getClientIp falls back to
  // 'unknown' without TRUST_PROXY_HEADERS) - cleared once per test rather
  // than per person, so a login refused on purpose in one test (e.g. the
  // password-only attempt right after enrolling) can never count toward
  // another test's own login attempts.
  clearRateLimit('staff-login-client:unknown');
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    const row = db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(personId) as
      | { codenaam: string }
      | undefined;
    if (row) clearRateLimit(`staff-login:unknown:${row.codenaam.toLowerCase()}`);
    clearRateLimit(`totp-setup:${personId}`);
    clearRateLimit(`totp-confirm:${personId}`);
    clearRateLimit(`totp-disable:${personId}`);
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
});

describe('POST /api/auth/totp/confirm', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await confirmTotp(
      new NextRequest('http://localhost/api/auth/totp/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setup_token: 'x', code: '000000' }),
      })
    );
    expect(res.status).toBe(401);
  });

  it('rejects a code that does not match the setup token secret', async () => {
    const personId = await createStaff();
    const setupRes = await setupTotp(staffRequest('/api/auth/totp/setup', sessionCookie(personId)));
    const setupBody = await setupRes.json();

    const res = await confirmTotp(
      staffRequest('/api/auth/totp/confirm', sessionCookie(personId), {
        setup_token: setupBody.data.setup_token,
        code: '000000',
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_CODE');

    const row = db.prepare('SELECT totp_secret FROM dienstrooster_person WHERE id = ?').get(personId) as {
      totp_secret: string | null;
    };
    expect(row.totp_secret).toBeNull();
  });

  it('rejects a setup token issued to a different account', async () => {
    const owner = await createStaff();
    const other = await createStaff();
    const setupRes = await setupTotp(staffRequest('/api/auth/totp/setup', sessionCookie(owner)));
    const setupBody = await setupRes.json();
    const code = generateTOTPCode(setupBody.data.secret);

    const res = await confirmTotp(
      staffRequest('/api/auth/totp/confirm', sessionCookie(other), {
        setup_token: setupBody.data.setup_token,
        code,
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('SETUP_EXPIRED');
  });

  it('enrolling makes staff-login require a code, and disabling removes that requirement again', async () => {
    const personId = await createStaff();

    // Before enrolling: password alone logs in.
    const before = await staffLogin(loginRequest(`Test-${personId.slice(0, 8)}`, PASSWORD));
    expect(before.status).toBe(200);
    expect((await before.json()).data.totp_enrolled).toBe(false);

    const codenaam = await enroll(personId);

    // After enrolling: password alone is refused with TOTP_REQUIRED, not
    // treated as a failed login.
    const passwordOnly = await staffLogin(loginRequest(codenaam, PASSWORD));
    expect(passwordOnly.status).toBe(401);
    expect((await passwordOnly.json()).error.code).toBe('TOTP_REQUIRED');

    // The right password and a fresh code together succeed. A genuinely
    // fresh code, not just a second call to generateTOTPCode: that would
    // return the exact same 6 digits as the one just spent confirming
    // enrollment if both happen inside the same 30-second step, and
    // verifyTOTPCode's own replay protection (lib/auth.test.ts) correctly
    // refuses to accept the same step twice - moving the clock forward is
    // what makes this a distinct, legitimate login rather than a replay.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 31_000);
      const secretRow = db.prepare('SELECT totp_secret FROM dienstrooster_person WHERE id = ?').get(personId) as {
        totp_secret: string;
      };
      const loginCode = generateTOTPCode(secretRow.totp_secret);
      const withCode = await staffLogin(loginRequest(codenaam, PASSWORD, loginCode));
      expect(withCode.status).toBe(200);
      expect((await withCode.json()).data.totp_enrolled).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // Disabling (proving the password again) removes the requirement.
    const disableRes = await disableTotp(
      staffRequest('/api/auth/totp/disable', sessionCookie(personId), { wachtwoord: PASSWORD })
    );
    expect(disableRes.status).toBe(200);

    const after = await staffLogin(loginRequest(codenaam, PASSWORD));
    expect(after.status).toBe(200);
    expect((await after.json()).data.totp_enrolled).toBe(false);
  });
});
