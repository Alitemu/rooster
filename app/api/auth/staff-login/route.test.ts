import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashPassword } from '@/lib/auth';
import { clearRateLimit } from '@/lib/rateLimit';
import { POST } from './route';

/**
 * The hard rule: wrong passwords lock out the account they were aimed at,
 * not everyone behind the same address.
 *
 * The whole ward reaches the app through one NAT address, and failed
 * logins used to be counted per address only - ten wrong guesses at a
 * made-up codenaam from any computer on the ward network locked every
 * planner out for fifteen minutes. Guessing at one account must still be
 * limited, which the second test proves.
 */

const PASSWORD = 'Correct-Horse-9!';
const createdIds: string[] = [];
const usedCodenamen: string[] = [];

async function createPlanner(): Promise<string> {
  const id = crypto.randomUUID();
  const codenaam = `L-${id.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op)
     VALUES (?, ?, 'PLANNER', 1, ?, datetime('now'))`
  ).run(id, codenaam, await hashPassword(PASSWORD));
  createdIds.push(id);
  usedCodenamen.push(codenaam);
  return codenaam;
}

function login(codenaam: string, password: string) {
  usedCodenamen.push(codenaam);
  return POST(
    new NextRequest('http://localhost/api/auth/staff-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codenaam, password }),
    })
  );
}

afterEach(() => {
  clearRateLimit('staff-login-client:unknown');
  for (const c of usedCodenamen.splice(0)) clearRateLimit(`staff-login:unknown:${c.toLowerCase()}`);
  for (const id of createdIds.splice(0)) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
});

describe('POST /api/auth/staff-login rate limiting', () => {
  it('ten wrong guesses at another codenaam do not lock a planner out', async () => {
    const planner = await createPlanner();
    for (let i = 0; i < 10; i++) {
      expect((await login('bestaat-niet', 'fout')).status).toBe(401);
    }
    expect((await login('bestaat-niet', 'fout')).status).toBe(429);

    expect((await login(planner, PASSWORD)).status).toBe(200);
  }, 30_000);

  it('ten wrong guesses at one account do lock that account', async () => {
    const planner = await createPlanner();
    for (let i = 0; i < 10; i++) {
      expect((await login(planner, 'fout')).status).toBe(401);
    }
    expect((await login(planner, PASSWORD)).status).toBe(429);
  }, 30_000);

  it('refuses a non-string codenaam with a 400 instead of a 500', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/auth/staff-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codenaam: { a: 1 }, password: 'x' }),
      })
    );
    expect(res.status).toBe(400);
  });
});
