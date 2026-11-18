import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashPassword } from '@/lib/auth';
import { clearRateLimit } from '@/lib/rateLimit';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET, POST } from './route';
import { PATCH, DELETE } from './[id]/route';
import { POST as resetPassword } from './[id]/reset-password/route';
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

  // Audit 10: the name was checked, then the password hashed (which takes a
  // while and lets other requests in), then the row written. Two at once -
  // a double click, two beheerders - both passed the check: the same name
  // died on the UNIQUE constraint with a 500, and two names differing only
  // in case both went in, one of them unreachable at login.
  it('adds one account when the same name arrives twice at once', async () => {
    const admin = await account('ADMIN');
    const codenaam = `Dubbel-${crypto.randomUUID().slice(0, 6)}`;
    const add = (naam: string) => POST(req('/api/admin/accounts', admin.id, 'POST', { codenaam: naam, rol: 'PLANNER', wachtwoord: TIJDELIJK }));
    for (const pair of [
      [codenaam, codenaam],
      [`${codenaam}-b`, `${codenaam}-B`],
    ]) {
      const results = await Promise.all(pair.map(add));
      for (const r of results) if (r.status === 201) created.push((await r.json()).data.id);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const rows = db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_person WHERE codenaam = ? COLLATE NOCASE').get(pair[0]) as { n: number };
      expect(rows.n).toBe(1);
    }
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

  it('stores the chosen dienst, the AIOS too since step 5', async () => {
    const admin = await account('ADMIN');
    const ids: Record<string, string> = {};
    for (const dienst_type of ['ACHTERWACHT', 'AIOS'] as const) {
      const codenaam = `${dienst_type.slice(0, 2)}-${crypto.randomUUID().slice(0, 6)}`;
      const ok = await POST(req('/api/admin/accounts', admin.id, 'POST', { codenaam, rol: 'PLANNER', wachtwoord: TIJDELIJK, dienst_type }));
      expect(ok.status).toBe(201);
      ids[dienst_type] = (await ok.json()).data.id;
      created.push(ids[dienst_type]);
    }
    const list = await (await GET(req('/api/admin/accounts', admin.id))).json();
    for (const [dienst, id] of Object.entries(ids)) expect(list.data.find((a: { id: string }) => a.id === id).dienst_type).toBe(dienst);

    const wrong = await POST(req('/api/admin/accounts', admin.id, 'POST', { codenaam: 'x-onbekend', rol: 'PLANNER', wachtwoord: TIJDELIJK, dienst_type: 'NEURO' }));
    expect(wrong.status).toBe(400);
  });

  // 1.10.0, the beheerder's wish: an account made to try something could only be switched off.
  describe('deleting an account', () => {
    const bestaat = (id: string) => Boolean(db.prepare('SELECT 1 FROM dienstrooster_person WHERE id = ?').get(id));
    const lijst = async (admin: string) => (await (await GET(req('/api/admin/accounts', admin))).json()).data as Array<{ id: string; verwijderbaar: boolean }>;

    it('removes an account that has left no trace, and the audit log keeps that it existed', async () => {
      const admin = await account('ADMIN');
      const made = await POST(req('/api/admin/accounts', admin.id, 'POST', { codenaam: `Proef-${admin.id.slice(0, 6)}`, rol: 'PLANNER', wachtwoord: TIJDELIJK }));
      const id = (await made.json()).data.id as string;
      created.push(id);
      expect((await lijst(admin.id)).find((a) => a.id === id)?.verwijderbaar).toBe(true);

      const res = await DELETE(req(`/api/admin/accounts/${id}`, admin.id, 'DELETE'), params(id));
      expect(res.status).toBe(200);
      expect(bestaat(id)).toBe(false);
      expect((await lijst(admin.id)).some((a) => a.id === id)).toBe(false);

      // Who made it and who deleted it, with its name: the rows about it stay.
      const rijen = db.prepare(`SELECT actor_id, actie, nieuw_json FROM dienstrooster_audit_log WHERE entiteit = 'person' AND entiteit_id = ? ORDER BY tijdstip`).all(id) as Array<{
        actor_id: string;
        actie: string;
        nieuw_json: string;
      }>;
      expect(rijen.map((r) => r.actie)).toEqual(['UPDATE', 'DELETE']);
      expect(rijen.every((r) => r.actor_id === admin.id)).toBe(true);
      expect(JSON.parse(rijen[1].nieuw_json)).toMatchObject({ wijziging: 'account verwijderd door beheerder', codenaam: `Proef-${admin.id.slice(0, 6)}`, rol: 'PLANNER' });
      // Nothing in the database points to a person that is gone.
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.prepare(`DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ?`).run(id);
    });

    it('takes along what the account did to itself: it logged in and chose its own password', async () => {
      const admin = await account('ADMIN');
      const proef = await account('PLANNER');
      // As the change-password route writes it: the account itself is the actor.
      db.prepare(
        `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, nieuw_json, tijdstip) VALUES (?, ?, 'person', ?, 'UPDATE', '{"wijziging":"wachtwoord gewijzigd"}', datetime('now'))`
      ).run(crypto.randomUUID(), proef.id, proef.id);
      expect((await lijst(admin.id)).find((a) => a.id === proef.id)?.verwijderbaar).toBe(true);

      const res = await DELETE(req(`/api/admin/accounts/${proef.id}`, admin.id, 'DELETE'), params(proef.id));
      expect(res.status).toBe(200);
      expect(bestaat(proef.id)).toBe(false);
      expect(db.prepare('SELECT COUNT(*) c FROM dienstrooster_audit_log WHERE actor_id = ?').get(proef.id)).toEqual({ c: 0 });
      const weg = db.prepare(`SELECT nieuw_json FROM dienstrooster_audit_log WHERE entiteit_id = ? AND actie = 'DELETE'`).get(proef.id) as { nieuw_json: string };
      expect(JSON.parse(weg.nieuw_json).eigen_wijzigingen_verwijderd).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.prepare(`DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ?`).run(proef.id);
    });

    it('refuses an account that the history names, which stays and can be switched off', async () => {
      const admin = await account('ADMIN');
      // Three ways an account ends up in the history: it changed something in a roster (the audit log),
      // it changed a setting, it published a period.
      const sporen: Array<[string, (id: string) => () => void]> = [
        [
          'a change in a roster',
          (id) => {
            const rij = crypto.randomUUID();
            db.prepare(
              `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, nieuw_json, tijdstip) VALUES (?, ?, 'assignment', 'x', 'UPDATE', '{}', datetime('now'))`
            ).run(rij, id);
            return () => db.prepare('DELETE FROM dienstrooster_audit_log WHERE id = ?').run(rij);
          },
        ],
        [
          'a setting',
          (id) => {
            const sleutel = `test-${id}`;
            db.prepare(`INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op, gewijzigd_door) VALUES (?, 'x', datetime('now'), ?)`).run(sleutel, id);
            return () => db.prepare('DELETE FROM dienstrooster_app_setting WHERE sleutel = ?').run(sleutel);
          },
        ],
        [
          'something it did to another account',
          (id) => {
            const rij = crypto.randomUUID();
            db.prepare(
              `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, nieuw_json, tijdstip) VALUES (?, ?, 'person', ?, 'UPDATE', '{}', datetime('now'))`
            ).run(rij, id, admin.id);
            return () => db.prepare('DELETE FROM dienstrooster_audit_log WHERE id = ?').run(rij);
          },
        ],
      ];
      for (const [wat, zet] of sporen) {
        const proef = await account('PLANNER');
        const ruimOp = zet(proef.id);
        try {
          expect((await lijst(admin.id)).find((a) => a.id === proef.id)?.verwijderbaar, wat).toBe(false);
          const res = await DELETE(req(`/api/admin/accounts/${proef.id}`, admin.id, 'DELETE'), params(proef.id));
          expect(res.status, wat).toBe(409);
          const fout = (await res.json()).error;
          expect(fout.code).toBe('IN_GEBRUIK');
          expect(fout.message).toMatch(/kan daarom niet worden verwijderd\. Schakel het uit\./);
          // In Dutch, without a raw database error.
          expect(fout.message).not.toMatch(/FOREIGN KEY|constraint|SQLITE/i);
          expect(bestaat(proef.id), wat).toBe(true);
          // Switching it off still works.
          expect((await PATCH(req(`/api/admin/accounts/${proef.id}`, admin.id, 'PATCH', { actief: false }), params(proef.id))).status).toBe(200);
        } finally {
          ruimOp();
        }
      }
    });

    it('is for a beheerder only, never on the own account, and only on a staff account', async () => {
      const admin = await account('ADMIN');
      const planner = await account('PLANNER');
      const proef = await account('PLANNER');
      expect((await DELETE(req(`/api/admin/accounts/${proef.id}`, planner.id, 'DELETE'), params(proef.id))).status).toBe(401);
      expect((await DELETE(req(`/api/admin/accounts/${proef.id}`, null, 'DELETE'), params(proef.id))).status).toBe(401);
      expect(bestaat(proef.id)).toBe(true);

      const eigen = await DELETE(req(`/api/admin/accounts/${admin.id}`, admin.id, 'DELETE'), params(admin.id));
      expect(eigen.status).toBe(409);
      expect((await eigen.json()).error.code).toBe('OWN_ACCOUNT');
      expect(bestaat(admin.id)).toBe(true);

      // A participant is not an account of this page: not found, and still there.
      const deelnemer = crypto.randomUUID();
      db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(deelnemer, `D-${deelnemer.slice(0, 8)}`);
      created.push(deelnemer);
      expect((await DELETE(req(`/api/admin/accounts/${deelnemer}`, admin.id, 'DELETE'), params(deelnemer))).status).toBe(404);
      expect(bestaat(deelnemer)).toBe(true);
      expect((await DELETE(req('/api/admin/accounts/bestaat-niet', admin.id, 'DELETE'), params('bestaat-niet'))).status).toBe(404);
    });

    it('ends the session of the deleted account at once', async () => {
      const admin = await account('ADMIN');
      const proef = await account('ADMIN');
      // The cookie the deleted beheerder still holds in a browser.
      const metCookie = () => req('/api/admin/accounts', proef.id);
      const voor = metCookie();
      const na = metCookie();
      expect((await GET(voor)).status).toBe(200);
      expect((await DELETE(req(`/api/admin/accounts/${proef.id}`, admin.id, 'DELETE'), params(proef.id))).status).toBe(200);
      expect((await GET(na)).status).toBe(401);
      db.prepare(`DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ?`).run(proef.id);
    });

    it('frees the codenaam: a new account can take it', async () => {
      const admin = await account('ADMIN');
      const naam = `Opnieuw-${admin.id.slice(0, 6)}`;
      const eerste = (await (await POST(req('/api/admin/accounts', admin.id, 'POST', { codenaam: naam, rol: 'PLANNER', wachtwoord: TIJDELIJK }))).json()).data.id as string;
      created.push(eerste);
      expect((await POST(req('/api/admin/accounts', admin.id, 'POST', { codenaam: naam, rol: 'PLANNER', wachtwoord: TIJDELIJK }))).status).toBe(409);
      expect((await DELETE(req(`/api/admin/accounts/${eerste}`, admin.id, 'DELETE'), params(eerste))).status).toBe(200);
      const tweede = await POST(req('/api/admin/accounts', admin.id, 'POST', { codenaam: naam, rol: 'PLANNER', wachtwoord: TIJDELIJK }));
      expect(tweede.status).toBe(201);
      created.push((await tweede.json()).data.id);
      db.prepare(`DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ?`).run(eerste);
    });

    it('counts every column of the database that points to a person', () => {
      // heeftSporen reads them from the database, so a table added later blocks a deletion by itself
      // instead of failing it on a foreign key. This list is what there is today: when it grows, look
      // whether the new one is a trace (it is, unless it is the account's own doing, as its audit rows are).
      const kolommen = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dienstrooster_%'`).all() as Array<{ name: string }>)
        .flatMap(({ name }) => (db.prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<{ table: string; from: string }>).filter((f) => f.table === 'dienstrooster_person').map((f) => `${name.replace('dienstrooster_', '')}.${f.from}`));
      expect(kolommen.length).toBeGreaterThanOrEqual(36);
      for (const k of ['audit_log.actor_id', 'app_setting.gewijzigd_door', 'schedule_period.gepubliceerd_door_person_id', 'assignment_edit.bewerkt_door_person_id', 'ledger_entry.aangemaakt_door', 'import_run.uitgevoerd_door', 'pending_undo.actor_id']) {
        expect(kolommen, k).toContain(k);
      }
    });
  });
});
