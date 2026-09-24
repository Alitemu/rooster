import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashPassword } from '@/lib/auth';
import { clearRateLimit } from '@/lib/rateLimit';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { DEFAULT_TEST_PASSWORD } from '@/lib/seedPassword';
import { POST as login } from './route';
import { POST as changePassword } from '../change-password/route';
import { GET as me } from '../me/route';
import { GET as mailSettings } from '@/app/api/planner/mail-settings/route';

/**
 * The hard rule: the password scripts/seed.ts sets is public with the
 * code, so a login with it may do nothing until the password is changed.
 * ALLOW_SEED_PASSWORD=true lifts that for local test runs only.
 */

const created: string[] = [];

async function plannerWithSeedPassword(): Promise<string> {
  const id = crypto.randomUUID();
  const codenaam = `SP-${id.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op)
     VALUES (?, ?, 'PLANNER', 1, ?, datetime('now'))`
  ).run(id, codenaam, await hashPassword(DEFAULT_TEST_PASSWORD));
  created.push(id);
  return codenaam;
}

async function loginCookie(codenaam: string, password: string) {
  const res = await login(
    new NextRequest('http://localhost/api/auth/staff-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codenaam, password }),
    })
  );
  const cookie = res.cookies.get(SESSION_COOKIE_NAME)?.value;
  return { res, cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
}

const get = (url: string, cookie: string) => new NextRequest(url, { headers: { Cookie: cookie } });

function change(cookie: string, huidig: string, nieuw: string) {
  return changePassword(
    new NextRequest('http://localhost/api/auth/change-password', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ huidig_wachtwoord: huidig, nieuw_wachtwoord: nieuw }),
    })
  );
}

afterEach(() => {
  delete process.env.ALLOW_SEED_PASSWORD;
  clearRateLimit('staff-login-client:unknown');
  for (const id of created.splice(0)) {
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(id);
    clearRateLimit(`change-password:${id}`);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
});

describe('logging in with the public seed password', () => {
  it('gives a session that can only change the password, and a full one after that', async () => {
    const codenaam = await plannerWithSeedPassword();
    const { res, cookie } = await loginCookie(codenaam, DEFAULT_TEST_PASSWORD);
    expect(res.status).toBe(200);
    expect((await res.json()).data.wachtwoord_wijzigen).toBe(true);

    // Nothing else: not the planner's routes.
    expect((await mailSettings(get('http://localhost/api/planner/mail-settings', cookie))).status).toBe(401);
    expect((await (await me(get('http://localhost/api/auth/me', cookie))).json()).data).toMatchObject({
      authenticated: true,
      wachtwoord_wijzigen: true,
    });

    // The seed password itself is not accepted as the new one.
    const again = await change(cookie, DEFAULT_TEST_PASSWORD, DEFAULT_TEST_PASSWORD);
    expect(again.status).toBe(400);
    expect((await again.json()).error.message).toContain('openbaar');

    const changed = await change(cookie, DEFAULT_TEST_PASSWORD, 'Eigen-Wachtwoord-42!');
    expect(changed.status).toBe(200);
    const fresh = `${SESSION_COOKIE_NAME}=${changed.cookies.get(SESSION_COOKIE_NAME)?.value}`;
    expect((await mailSettings(get('http://localhost/api/planner/mail-settings', fresh))).status).toBe(200);
    // The flagged session was revoked with the change.
    expect((await mailSettings(get('http://localhost/api/planner/mail-settings', cookie))).status).toBe(401);
  }, 30_000);

  it('does not ask for it on a local test run with ALLOW_SEED_PASSWORD=true', async () => {
    process.env.ALLOW_SEED_PASSWORD = 'true';
    const codenaam = await plannerWithSeedPassword();
    const { res, cookie } = await loginCookie(codenaam, DEFAULT_TEST_PASSWORD);
    expect((await res.json()).data.wachtwoord_wijzigen).toBe(false);
    expect((await mailSettings(get('http://localhost/api/planner/mail-settings', cookie))).status).toBe(200);
  }, 30_000);
});
