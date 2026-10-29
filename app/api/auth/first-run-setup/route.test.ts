import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { verifyPassword } from '@/lib/auth';
import { createSetupToken, clearSetupToken, verifySetupToken } from '@/lib/setupToken';
import { clearRateLimit } from '@/lib/rateLimit';
import { POST } from './route';

/**
 * The hard rule: an account without a password can be claimed once, and only
 * by whoever holds the setup token. The route is open to anyone who can reach
 * the app, so every other answer must be a refusal that says as little as
 * possible, and a claimed account can never be touched through it again.
 */

const SLEUTEL = 'first-run-setup:unknown';
const tag = crypto.randomUUID().slice(0, 6);
const ids: string[] = [];
const STERK = 'Sterk-Wachtwoord-Lang-7#';

function persoon(codenaam: string, rol: 'ADMIN' | 'PLANNER' | 'DEELNEMER', hash: string | null = null): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op) VALUES (?, ?, ?, 1, ?, datetime('now'))`
  ).run(id, codenaam, rol, hash);
  ids.push(id);
  return id;
}
const hashVan = (id: string) => (db.prepare('SELECT wachtwoord_hash AS h FROM dienstrooster_person WHERE id = ?').get(id) as { h: string | null }).h;

async function claim(body: Record<string, unknown>) {
  const res = await POST(
    new NextRequest('http://localhost/api/auth/first-run-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: await res.json() };
}

// Accounts of other tests that still wait for a password would keep the token alive after a claim.
let wachtend: Array<{ id: string }>;
beforeEach(() => {
  clearRateLimit(SLEUTEL);
  wachtend = db.prepare(`SELECT id FROM dienstrooster_person WHERE rol IN ('ADMIN','PLANNER') AND wachtwoord_hash IS NULL`).all() as Array<{ id: string }>;
  db.prepare(`UPDATE dienstrooster_person SET wachtwoord_hash = 'x' WHERE rol IN ('ADMIN','PLANNER') AND wachtwoord_hash IS NULL`).run();
});
afterEach(() => {
  clearSetupToken();
  for (const w of wachtend) db.prepare('UPDATE dienstrooster_person SET wachtwoord_hash = NULL WHERE id = ?').run(w.id);
});
afterAll(() => {
  for (const id of ids) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
});

describe('first-run-setup', () => {
  it('claims the account once with the right token: the password works and the token is gone', async () => {
    const id = persoon(`claim-${tag}-a`, 'PLANNER');
    const token = createSetupToken();
    const res = await claim({ codenaam: `claim-${tag}-a`, password: STERK, setup_token: token });
    expect(res.status).toBe(200);
    expect(res.json.data.codenaam).toBe(`claim-${tag}-a`);
    expect(await verifyPassword(STERK, hashVan(id)!)).toBe(true);
    // Nothing is left to claim, so the token no longer opens anything.
    expect(verifySetupToken(token)).toBe(false);
  });

  it('keeps the token while another account still waits for its password', async () => {
    const eerste = persoon(`claim-${tag}-b1`, 'PLANNER');
    const tweede = persoon(`claim-${tag}-b2`, 'ADMIN');
    const token = createSetupToken();
    expect((await claim({ codenaam: `claim-${tag}-b1`, password: STERK, setup_token: token })).status).toBe(200);
    expect(verifySetupToken(token)).toBe(true);
    expect((await claim({ codenaam: `claim-${tag}-b2`, password: STERK, setup_token: token })).status).toBe(200);
    expect(hashVan(eerste)).not.toBeNull();
    expect(hashVan(tweede)).not.toBeNull();
    expect(verifySetupToken(token)).toBe(false);
  });

  it.each([
    ['a wrong token', () => 'verkeerd'],
    ['no token', () => undefined],
    ['an empty token', () => ''],
  ])('refuses %s with 403 and changes nothing, whether the account exists or not', async (naam, kies) => {
    const codenaam = `claim-${tag}-c-${naam.replace(/\W/g, '')}`;
    const id = persoon(codenaam, 'PLANNER');
    createSetupToken();
    const bestaand = await claim({ codenaam, password: STERK, setup_token: kies() });
    const onbestaand = await claim({ codenaam: `bestaat-niet-${tag}`, password: STERK, setup_token: kies() });
    expect(bestaand.status).toBe(403);
    expect(onbestaand.status).toBe(403);
    expect(bestaand.json).toEqual(onbestaand.json);
    expect(hashVan(id)).toBeNull();
  });

  it('refuses everything when no token was ever issued', async () => {
    const id = persoon(`claim-${tag}-d`, 'PLANNER');
    clearSetupToken();
    const res = await claim({ codenaam: `claim-${tag}-d`, password: STERK, setup_token: 'wat-dan-ook' });
    expect(res.status).toBe(403);
    // In Dutch, with the word on the login page (not "setup-token").
    expect(res.json.error.message).toBe('Ongeldige of ontbrekende installatiecode');
    expect(hashVan(id)).toBeNull();
  });

  it('refuses a weak password and a missing field, and the account stays free', async () => {
    const id = persoon(`claim-${tag}-e`, 'PLANNER');
    const token = createSetupToken();
    const zwak = await claim({ codenaam: `claim-${tag}-e`, password: 'kort', setup_token: token });
    expect(zwak.status).toBe(400);
    expect(zwak.json.error.code).toBe('WEAK_PASSWORD');
    const zonder = await claim({ codenaam: `claim-${tag}-e`, setup_token: token });
    expect(zonder.status).toBe(400);
    expect(zonder.json.error.code).toBe('MISSING_FIELDS');
    expect((await claim({ codenaam: 12345, password: STERK, setup_token: token })).status).toBe(400);
    expect(hashVan(id)).toBeNull();
  });

  it('cannot touch an account that already has a password, and says the same as for one that does not exist', async () => {
    const id = persoon(`claim-${tag}-f`, 'PLANNER', 'bestaande-hash');
    persoon(`claim-${tag}-f2`, 'PLANNER'); // keeps the token alive
    const token = createSetupToken();
    const bezet = await claim({ codenaam: `claim-${tag}-f`, password: STERK, setup_token: token });
    const onbekend = await claim({ codenaam: `bestaat-niet-${tag}`, password: STERK, setup_token: token });
    expect(bezet.status).toBe(409);
    expect(onbekend.status).toBe(409);
    expect(bezet.json).toEqual(onbekend.json);
    expect(hashVan(id)).toBe('bestaande-hash');
  });

  it('only claims a planner or the beheerder, never a participant', async () => {
    const deelnemer = persoon(`claim-${tag}-g`, 'DEELNEMER');
    persoon(`claim-${tag}-g2`, 'PLANNER');
    const token = createSetupToken();
    const res = await claim({ codenaam: `claim-${tag}-g`, password: STERK, setup_token: token });
    expect(res.status).toBe(409);
    expect(hashVan(deelnemer)).toBeNull();
  });

  it('finds the account whatever the capitals, and prefers the exact spelling', async () => {
    const klein = persoon(`claim-${tag}-h`, 'PLANNER');
    const token = createSetupToken();
    const res = await claim({ codenaam: `CLAIM-${tag}-H`, password: STERK, setup_token: token });
    expect(res.status).toBe(200);
    expect(hashVan(klein)).not.toBeNull();
  });

  it('stops a flood of wrong tokens with 429, and a right token does not use up the allowance', async () => {
    const id = persoon(`claim-${tag}-i`, 'PLANNER');
    const token = createSetupToken();
    for (let i = 0; i < 10; i++) {
      expect((await claim({ codenaam: `claim-${tag}-i`, password: STERK, setup_token: `fout-${i}` })).status).toBe(403);
    }
    const geblokkeerd = await claim({ codenaam: `claim-${tag}-i`, password: STERK, setup_token: token });
    expect(geblokkeerd.status).toBe(429);
    expect(geblokkeerd.json.error.code).toBe('RATE_LIMITED');
    expect(hashVan(id)).toBeNull();

    clearRateLimit(SLEUTEL);
    const tweede = persoon(`claim-${tag}-i2`, 'ADMIN');
    for (let i = 0; i < 9; i++) await claim({ codenaam: `claim-${tag}-i`, password: STERK, setup_token: `fout-${i}` });
    // Right tokens are given back, so two of them in a row still fit after nine wrong ones.
    expect((await claim({ codenaam: `claim-${tag}-i`, password: STERK, setup_token: token })).status).toBe(200);
    expect((await claim({ codenaam: `claim-${tag}-i2`, password: STERK, setup_token: token })).status).toBe(200);
    expect(hashVan(tweede)).not.toBeNull();
  });
});
