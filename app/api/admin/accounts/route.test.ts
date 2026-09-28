import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashPassword } from '@/lib/auth';
import { clearRateLimit } from '@/lib/rateLimit';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET, POST } from './route';
import { PATCH } from './[id]/route';
import { POST as resetPassword } from './[id]/reset-password/route';
import { POST as disableTotp } from './[id]/totp-disable/route';
import { POST as login } from '../../auth/staff-login/route';
import { POST as changePassword } from '../../auth/change-password/route';

/**
 * The rules: only a beheerder (ADMIN) manages staff accounts, a planner
 * can't; an account given a temporary password must choose its own at the
 * next login, and all its sessions end; a beheerder never manages their own
 * account here, and the last active beheerder can't be switched off.
 */

const PASSWORD = 'Eigen-Wachtwoord-7!';
const TIJDELIJK = 'Tijdelijk-Ww-2026!';
const created: string[] = [];

async function account(rol: 'ADMIN' | 'PLANNER', extra: { totp?: string } = {}): Promise<{ id: string; codenaam: string }> {
  const id = crypto.randomUUID();
  const codenaam = `A-${id.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, totp_secret, aangemaakt_op)
     VALUES (?, ?, ?, 1, ?, ?, datetime('now'))`
  ).run(id, codenaam, rol, await hashPassword(PASSWORD), extra.totp ?? null);
  created.push(id);
  return { id, codenaam };
}

function req(url: string, actorId: string | null, method = 'GET', body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (actorId) {
    const token = createSessionToken(
      { kind: 'staff', personId: actorId, sessionVersion: getSessionVersion(actorId)! } as never,
      STAFF_SESSION_MAX_AGE_SECONDS
    );
    headers.Cookie = `${SESSION_COOKIE_NAME}=${token}`;
  }
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const row = (id: string) =>
  db.prepare('SELECT rol, actief, totp_secret, sessie_versie, wachtwoord_moet_wijzigen FROM dienstrooster_person WHERE id = ?').get(id) as {
    rol: string;
    actief: number;
    totp_secret: string | null;
    sessie_versie: number;
    wachtwoord_moet_wijzigen: number;
  };

afterEach(() => {
  clearRateLimit('staff-login-client:unknown');
  const ids = created.splice(0);
  for (const id of ids) db.prepare('DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ? OR actor_id = ?').run(id, id);
  for (const id of ids) {
    clearRateLimit(`change-password:${id}`);
    const c = db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(id) as { codenaam: string } | undefined;
    if (c) clearRateLimit(`staff-login:unknown:${c.codenaam.toLowerCase()}`);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
});

describe('/api/admin/accounts', () => {
  it('is for a beheerder only, not a planner', async () => {
    const planner = await account('PLANNER');
    expect((await GET(req('/api/admin/accounts', planner.id))).status).toBe(401);
    expect(
      (await POST(req('/api/admin/accounts', planner.id, 'POST', { codenaam: 'x-nieuw', rol: 'ADMIN', wachtwoord: TIJDELIJK }))).status
    ).toBe(401);

    const admin = await account('ADMIN');
    const list = await (await GET(req('/api/admin/accounts', admin.id))).json();
    expect(list.data.map((a: { codenaam: string }) => a.codenaam)).toContain(planner.codenaam);
  });

  it('adds an account that must choose its own password at the first login', async () => {
    const admin = await account('ADMIN');
    const codenaam = `N-${crypto.randomUUID().slice(0, 8)}`;
    const res = await POST(req('/api/admin/accounts', admin.id, 'POST', { codenaam, rol: 'PLANNER', wachtwoord: TIJDELIJK }));
    expect(res.status).toBe(201);
    const id = (await res.json()).data.id;
    created.push(id);

    const first = await (
      await login(req('/api/auth/staff-login', null, 'POST', { codenaam, password: TIJDELIJK }))
    ).json();
    expect(first.data.wachtwoord_wijzigen).toBe(true);
    expect(first.data.tijdelijk_wachtwoord).toBe(true);

    // Choosing a new one clears it.
    const changed = await changePassword(
      req('/api/auth/change-password', id, 'POST', { huidig_wachtwoord: TIJDELIJK, nieuw_wachtwoord: PASSWORD })
    );
    expect(changed.status).toBe(200);
    expect(row(id).wachtwoord_moet_wijzigen).toBe(0);
  });

  it('refuses a weak temporary password, an e-mail address and a codenaam in use', async () => {
    const admin = await account('ADMIN');
    const other = await account('PLANNER');
    const add = (body: unknown) => POST(req('/api/admin/accounts', admin.id, 'POST', body));
    expect((await add({ codenaam: 'zwak-ww', rol: 'PLANNER', wachtwoord: 'kort' })).status).toBe(400);
    expect((await add({ codenaam: 'iemand@example.org', rol: 'PLANNER', wachtwoord: TIJDELIJK })).status).toBe(400);
    expect((await add({ codenaam: other.codenaam, rol: 'PLANNER', wachtwoord: TIJDELIJK })).status).toBe(409);
    // Only differing in case would make one of the two unreachable at login.
    expect((await add({ codenaam: other.codenaam.toLowerCase(), rol: 'PLANNER', wachtwoord: TIJDELIJK })).status).toBe(409);
    expect((await add({ codenaam: 'rare-rol', rol: 'DEELNEMER', wachtwoord: TIJDELIJK })).status).toBe(400);
  });

  it('resets a password: sessions end and the next login must choose a new one', async () => {
    const admin = await account('ADMIN');
    const planner = await account('PLANNER');
    const before = row(planner.id).sessie_versie;

    const res = await resetPassword(
      req(`/api/admin/accounts/${planner.id}/reset-password`, admin.id, 'POST', { wachtwoord: TIJDELIJK }),
      params(planner.id)
    );
    expect(res.status).toBe(200);
    expect(row(planner.id).sessie_versie).toBe(before + 1);
    expect(row(planner.id).wachtwoord_moet_wijzigen).toBe(1);

    const old = await login(req('/api/auth/staff-login', null, 'POST', { codenaam: planner.codenaam, password: PASSWORD }));
    expect(old.status).toBe(401);
    const neu = await (
      await login(req('/api/auth/staff-login', null, 'POST', { codenaam: planner.codenaam, password: TIJDELIJK }))
    ).json();
    expect(neu.data.wachtwoord_wijzigen).toBe(true);
  });

  it('works on another beheerder too, but never on one\'s own account', async () => {
    const admin = await account('ADMIN');
    const other = await account('ADMIN');
    const reset = (target: string) =>
      resetPassword(req(`/api/admin/accounts/${target}/reset-password`, admin.id, 'POST', { wachtwoord: TIJDELIJK }), params(target));
    expect((await reset(other.id)).status).toBe(200);
    expect((await reset(admin.id)).status).toBe(409);
  });

  it('turns off someone else\'s two-step verification', async () => {
    const admin = await account('ADMIN');
    const planner = await account('PLANNER', { totp: 'v1:iets' });
    const res = await disableTotp(req(`/api/admin/accounts/${planner.id}/totp-disable`, admin.id, 'POST'), params(planner.id));
    expect(res.status).toBe(200);
    expect(row(planner.id).totp_secret).toBeNull();
  });

  it('switches an account off, which then can\'t log in', async () => {
    const admin = await account('ADMIN');
    const planner = await account('PLANNER');
    const res = await PATCH(req(`/api/admin/accounts/${planner.id}`, admin.id, 'PATCH', { actief: false }), params(planner.id));
    expect(res.status).toBe(200);
    expect(row(planner.id).actief).toBe(0);
    expect((await login(req('/api/auth/staff-login', null, 'POST', { codenaam: planner.codenaam, password: PASSWORD }))).status).toBe(401);
  });

  it('lets a beheerder change another beheerder, never their own rights', async () => {
    // Everyone else who is ADMIN in the shared test database is set aside.
    const others = db.prepare(`SELECT id FROM dienstrooster_person WHERE rol = 'ADMIN' AND actief = 1`).all() as Array<{ id: string }>;
    db.prepare(`UPDATE dienstrooster_person SET actief = 0 WHERE rol = 'ADMIN'`).run();
    try {
      const admin = await account('ADMIN');
      const second = await account('ADMIN');
      // Two active: one may go.
      expect((await PATCH(req(`/api/admin/accounts/${second.id}`, admin.id, 'PATCH', { rol: 'PLANNER' }), params(second.id))).status).toBe(200);
      // Now admin is the last one; second (a planner now) can't act, and admin can't touch itself.
      expect((await PATCH(req(`/api/admin/accounts/${admin.id}`, admin.id, 'PATCH', { actief: false }), params(admin.id))).status).toBe(409);
    } finally {
      for (const o of others) db.prepare('UPDATE dienstrooster_person SET actief = 1 WHERE id = ?').run(o.id);
    }
  });

  it('stores the chosen dienst and refuses AIOS until it is in production', async () => {
    const admin = await account('ADMIN');
    const aios = await POST(
      req('/api/admin/accounts', admin.id, 'POST', { codenaam: `AIOS-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', wachtwoord: TIJDELIJK, dienst_type: 'AIOS' })
    );
    expect(aios.status).toBe(409);
    expect((await aios.json()).error.message).toContain('nog niet in productie');

    const codenaam = `AW-${crypto.randomUUID().slice(0, 6)}`;
    const ok = await POST(req('/api/admin/accounts', admin.id, 'POST', { codenaam, rol: 'PLANNER', wachtwoord: TIJDELIJK, dienst_type: 'ACHTERWACHT' }));
    expect(ok.status).toBe(201);
    const id = (await ok.json()).data.id;
    created.push(id);
    const list = await (await GET(req('/api/admin/accounts', admin.id))).json();
    expect(list.data.find((a: { id: string }) => a.id === id).dienst_type).toBe('ACHTERWACHT');

    const wrong = await POST(req('/api/admin/accounts', admin.id, 'POST', { codenaam: 'x-onbekend', rol: 'PLANNER', wachtwoord: TIJDELIJK, dienst_type: 'NEURO' }));
    expect(wrong.status).toBe(400);
  });
});
