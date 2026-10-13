import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { hashPassword } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST as staffLogin } from './staff-login/route';
import { POST as changePassword } from './change-password/route';
import { POST as disableTotp } from './totp/disable/route';

/**
 * The rule: ten wrong guesses per account, then a quarter of an hour of
 * nothing - also when the guesses arrive at the same moment.
 *
 * The routes check the limit first and count a failed attempt only after
 * bcrypt has compared the password, which is asynchronous. Requests that
 * arrive together all pass the check before the first one is counted, so
 * the limit holds for guesses one after the other but not for a burst.
 * Thirty guesses at once must still get no more than ten answers that
 * actually compared a password; the rest are refused (429) without one.
 */

const PASSWORD = 'Juist-Wachtw00rd!';
const BURST = 30;
const LIMIT = 10;
let rowidsBefore: Map<string, number>;

function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

async function staff(): Promise<{ id: string; codenaam: string; cookie: string }> {
  const id = crypto.randomUUID();
  const codenaam = `Burst-${id.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op) VALUES (?, ?, 'PLANNER', 1, ?, datetime('now'))`
  ).run(id, codenaam, await hashPassword(PASSWORD));
  const token = createSessionToken({ kind: 'staff', personId: id, sessionVersion: getSessionVersion(id)! } as never, STAFF_SESSION_MAX_AGE_SECONDS);
  return { id, codenaam, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

function post(handler: (req: NextRequest) => Promise<Response>, body: unknown, cookie = ''): Promise<Response> {
  return handler(
    new NextRequest('http://localhost/api/auth/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    })
  );
}

/** How the burst was answered: refused by the limit, or after a password was compared. */
async function burst(send: (i: number) => Promise<Response>): Promise<{ limited: number; compared: number; statuses: number[] }> {
  const statuses = (await Promise.all(Array.from({ length: BURST }, (_, i) => send(i)))).map((r) => r.status);
  const limited = statuses.filter((s) => s === 429).length;
  return { limited, compared: statuses.length - limited, statuses };
}

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('the guessing limit holds for guesses sent at the same moment', () => {
  it('one after the other: ten wrong passwords, then refused', async () => {
    const { codenaam } = await staff();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await post(staffLogin as never, { codenaam, password: `Fout-${i}-Wachtw00rd!` })).status);
    expect(statuses.slice(0, LIMIT).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(LIMIT)).toEqual([429, 429]);
  }, 30_000);

  // Audit 8: all thirty are compared - the check runs before any of them
  // has been counted.
  it.fails('logging in: thirty wrong passwords at once, at most ten compared', async () => {
    const { codenaam } = await staff();
    const result = await burst((i) => post(staffLogin as never, { codenaam, password: `Fout-${i}-Wachtw00rd!` }));
    expect(result.compared, JSON.stringify(result.statuses)).toBeLessThanOrEqual(LIMIT);
  }, 60_000);

  it.fails('changing the password: thirty wrong current passwords at once, at most ten compared', async () => {
    const { cookie } = await staff();
    const result = await burst((i) =>
      post(changePassword as never, { huidig_wachtwoord: `Fout-${i}-Wachtw00rd!`, nieuw_wachtwoord: 'Nieuw-Wachtw00rd!' }, cookie)
    );
    expect(result.compared, JSON.stringify(result.statuses)).toBeLessThanOrEqual(LIMIT);
  }, 60_000);

  it.fails('turning two-step verification off: thirty wrong passwords at once, at most ten compared', async () => {
    const { cookie } = await staff();
    const result = await burst((i) => post(disableTotp as never, { wachtwoord: `Fout-${i}-Wachtw00rd!` }, cookie));
    expect(result.compared, JSON.stringify(result.statuses)).toBeLessThanOrEqual(LIMIT);
  }, 60_000);
});
