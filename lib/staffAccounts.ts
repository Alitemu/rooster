/**
 * The staff accounts (ADMIN and PLANNER), managed by an admin.
 *
 * An ADMIN can do everything a planner can, and here also: add a planner or
 * admin account, give an account a temporary password, turn off someone's
 * two-step verification, switch an account off and delete one that has left
 * no trace (deleteStaffAccount, 1.10.0). A temporary password
 * sets `wachtwoord_moet_wijzigen`, so the next login can only choose a new
 * one (like a login with the seed password): the admin knows the temporary
 * one, only its owner should know the one the account goes on with.
 *
 * An admin never manages their own account here (that is "Wachtwoord
 * wijzigen"), so nobody can lock themselves out,
 * and the last active admin can't be switched off or made planner.
 * Every change ends the account's sessions and goes into the audit log,
 * without any password material.
 */

import { db } from '@/db/client';
import { hashPassword, validatePasswordStrength } from './auth';
import { validateCodenaam } from './codenaam';
import { DEFAULT_TEST_PASSWORD } from './seedPassword';
import { revokeAllSessions } from './sessionVersion';

export type StaffRol = 'ADMIN' | 'PLANNER';

/**
 * The kind of dienst a staff account plans. Until 0.81.0 an AIOS account
 * was refused while the AIOS roster was being built (docs/aios-rooster.md,
 * step 5); both are in use now.
 */
export const DIENST_TYPES = ['ACHTERWACHT', 'AIOS'] as const;
export type DienstType = (typeof DIENST_TYPES)[number];

export interface StaffAccount {
  id: string;
  codenaam: string;
  rol: StaffRol;
  actief: boolean;
  wachtwoord_ingesteld: boolean;
  wachtwoord_moet_wijzigen: boolean;
  dienst_type: DienstType | null;
  /** Nothing in a roster or its history refers to it: the beheerder may delete it (heeftSporen). */
  verwijderbaar: boolean;
}

export type AccountResult = { ok: true } | { ok: false; status: number; code: string; message: string };

const fail = (status: number, code: string, message: string): AccountResult => ({ ok: false, status, code, message });

export function listStaffAccounts(): StaffAccount[] {
  return (
    db
      .prepare(
        `SELECT id, codenaam, rol, actief, wachtwoord_hash, wachtwoord_moet_wijzigen, dienst_type
         FROM dienstrooster_person WHERE rol IN ('ADMIN', 'PLANNER') ORDER BY rol, codenaam`
      )
      .all() as Array<{
      id: string;
      codenaam: string;
      rol: StaffRol;
      actief: number;
      wachtwoord_hash: string | null;
      wachtwoord_moet_wijzigen: number;
      dienst_type: DienstType | null;
    }>
  ).map((r) => ({
    id: r.id,
    codenaam: r.codenaam,
    rol: r.rol,
    actief: Boolean(r.actief),
    wachtwoord_ingesteld: Boolean(r.wachtwoord_hash),
    wachtwoord_moet_wijzigen: Boolean(r.wachtwoord_moet_wijzigen),
    dienst_type: r.dienst_type,
    verwijderbaar: !heeftSporen(r.id),
  }));
}

/**
 * Every column in the database that points to a person, read from the database itself: a table added
 * later counts without anyone remembering to add it here. The schema does not change while the app runs.
 */
let naarPersoon: Array<{ tabel: string; kolom: string }> | null = null;
function verwijzingenNaarPersoon(): Array<{ tabel: string; kolom: string }> {
  if (naarPersoon) return naarPersoon;
  const tabellen = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dienstrooster_%'`).all() as Array<{ name: string }>;
  naarPersoon = tabellen.flatMap(({ name }) =>
    (db.prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<{ table: string; from: string }>)
      .filter((fk) => fk.table === 'dienstrooster_person')
      .map((fk) => ({ tabel: name, kolom: fk.from }))
  );
  return naarPersoon;
}

/**
 * Whether anything refers to this account besides what it did to itself. A person is never deleted
 * from this app, because the roster and its history name them: who published, who assigned, who
 * changed a setting. An account that did any of that stays (switched off); one that did not can go.
 * What it did to itself (its own password, its own two-step verification) are audit rows that go with it.
 */
function heeftSporen(personId: string): boolean {
  return verwijzingenNaarPersoon().some(({ tabel, kolom }) => {
    const eigen = tabel === 'dienstrooster_audit_log' && kolom === 'actor_id' ? ` AND NOT (entiteit = 'person' AND entiteit_id = @id)` : '';
    return Boolean(db.prepare(`SELECT 1 FROM ${tabel} WHERE ${kolom} = @id${eigen} LIMIT 1`).get({ id: personId }));
  });
}

/** Dutch reasons a password can't be used, empty when it can. */
export function temporaryPasswordProblems(password: unknown): string[] {
  if (typeof password !== 'string') return ['Wachtwoord is verplicht'];
  const problems = validatePasswordStrength(password);
  if (password === DEFAULT_TEST_PASSWORD) problems.push('Dit wachtwoord staat openbaar in de broncode');
  return problems;
}

function audit(actorId: string, targetId: string, wijziging: Record<string, unknown>, actie: 'UPDATE' | 'DELETE' = 'UPDATE') {
  db.prepare(
    `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, nieuw_json, tijdstip)
     VALUES (?, ?, 'person', ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), actorId, targetId, actie, JSON.stringify(wijziging), new Date().toISOString());
}

function staffTarget(
  actorId: string,
  targetId: string
): { rol: StaffRol; actief: number; codenaam: string } | Extract<AccountResult, { ok: false }> {
  if (targetId === actorId) {
    return {
      ok: false,
      status: 409,
      code: 'OWN_ACCOUNT',
      message: 'Je eigen account beheer je met Wachtwoord wijzigen.',
    };
  }
  const row = db
    .prepare(`SELECT rol, actief, codenaam FROM dienstrooster_person WHERE id = ? AND rol IN ('ADMIN', 'PLANNER')`)
    .get(targetId) as { rol: StaffRol; actief: number; codenaam: string } | undefined;
  return row ?? { ok: false, status: 404, code: 'NOT_FOUND', message: 'Account niet gevonden' };
}

const isFailure = (x: unknown): x is Extract<AccountResult, { ok: false }> =>
  typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;

function activeAdminCount(): number {
  return (db.prepare(`SELECT COUNT(*) c FROM dienstrooster_person WHERE rol = 'ADMIN' AND actief = 1`).get() as { c: number }).c;
}

export async function createStaffAccount(
  actorId: string,
  input: { codenaam: unknown; rol: unknown; wachtwoord: unknown; dienst_type?: unknown }
): Promise<AccountResult & { id?: string }> {
  const naam = validateCodenaam(input.codenaam);
  if (!naam.valid) return fail(400, 'INVALID_CODENAAM', naam.message);
  if (input.rol !== 'ADMIN' && input.rol !== 'PLANNER') return fail(400, 'INVALID_ROL', 'Kies planner of beheerder');
  const dienst = input.dienst_type ?? 'ACHTERWACHT';
  if (!DIENST_TYPES.includes(dienst as DienstType)) return fail(400, 'INVALID_DIENST', 'Kies Achterwacht of AIOS');
  const problems = temporaryPasswordProblems(input.wachtwoord);
  if (problems.length > 0) return fail(400, 'WEAK_PASSWORD', problems.join(', '));
  // Staff log in without regard to case, so "Planner" next to "planner"
  // would make one of them unreachable.
  const taken = () => Boolean(db.prepare('SELECT 1 FROM dienstrooster_person WHERE codenaam = ? COLLATE NOCASE').get(naam.codenaam));
  if (taken()) return fail(409, 'CODENAAM_TAKEN', 'Deze codenaam is al in gebruik');
  const hash = await hashPassword(input.wachtwoord as string);
  const id = crypto.randomUUID();
  // Asked again with the write: hashing takes a while, and another request
  // for the same name (a double click, a second beheerder) can pass the
  // check above meanwhile - it then died on the UNIQUE constraint with a
  // 500, or, differing only in case, went in as a second account (audit 10).
  const added = db.transaction(() => {
    if (taken()) return false;
    db.prepare(
      `INSERT INTO dienstrooster_person
         (id, codenaam, rol, actief, wachtwoord_hash, wachtwoord_moet_wijzigen, dienst_type, aangemaakt_op)
       VALUES (?, ?, ?, 1, ?, 1, ?, ?)`
    ).run(id, naam.codenaam, input.rol, hash, dienst, new Date().toISOString());
    audit(actorId, id, { wijziging: 'account aangemaakt', rol: input.rol, dienst_type: dienst });
    return true;
  })();
  if (!added) return fail(409, 'CODENAAM_TAKEN', 'Deze codenaam is al in gebruik');
  return { ok: true, id };
}

export async function resetStaffPassword(actorId: string, targetId: string, wachtwoord: unknown): Promise<AccountResult> {
  const target = staffTarget(actorId, targetId);
  if (isFailure(target)) return target;
  const problems = temporaryPasswordProblems(wachtwoord);
  if (problems.length > 0) return fail(400, 'WEAK_PASSWORD', problems.join(', '));
  const hash = await hashPassword(wachtwoord as string);
  db.transaction(() => {
    db.prepare('UPDATE dienstrooster_person SET wachtwoord_hash = ?, wachtwoord_moet_wijzigen = 1 WHERE id = ?').run(
      hash,
      targetId
    );
    revokeAllSessions(targetId);
    audit(actorId, targetId, { wijziging: 'tijdelijk wachtwoord ingesteld door beheerder', sessies_ingetrokken: true });
  })();
  return { ok: true };
}

export function updateStaffAccount(
  actorId: string,
  targetId: string,
  input: { actief?: unknown; rol?: unknown }
): AccountResult {
  const target = staffTarget(actorId, targetId);
  if (isFailure(target)) return target;
  const actief = input.actief === undefined ? Boolean(target.actief) : input.actief;
  const rol = input.rol === undefined ? target.rol : input.rol;
  if (typeof actief !== 'boolean') return fail(400, 'INVALID', 'Ongeldig verzoek');
  if (rol !== 'ADMIN' && rol !== 'PLANNER') return fail(400, 'INVALID_ROL', 'Kies planner of beheerder');
  const staysActiveAdmin = actief && rol === 'ADMIN';
  if (target.rol === 'ADMIN' && target.actief && !staysActiveAdmin && activeAdminCount() <= 1) {
    return fail(409, 'LAST_ADMIN', 'Er moet minstens één actieve beheerder overblijven.');
  }
  db.transaction(() => {
    db.prepare('UPDATE dienstrooster_person SET actief = ?, rol = ? WHERE id = ?').run(actief ? 1 : 0, rol, targetId);
    // Switched off or given fewer rights: sessions opened before end now.
    if (!actief || rol !== target.rol) revokeAllSessions(targetId);
    audit(actorId, targetId, { wijziging: 'account aangepast door beheerder', actief, rol });
  })();
  return { ok: true };
}

/**
 * Deletes a staff account that has left no trace (1.10.0, the beheerder's wish: an account made by
 * mistake or to try something could only be switched off, and stayed in the list for good).
 *
 * Only such an account: one that published a roster, assigned a dienst or changed a setting is named in
 * the history, which must keep saying who did it. That one is switched off instead (heeftSporen).
 * Never one's own account, so another active beheerder is always left.
 *
 * The audit log keeps that it existed: the row of its creation stays, and the row written here names the
 * codenaam, which is then free again.
 */
export function deleteStaffAccount(actorId: string, targetId: string): AccountResult {
  const target = staffTarget(actorId, targetId);
  if (isFailure(target)) return target;
  return db.transaction((): AccountResult => {
    if (heeftSporen(targetId)) {
      return fail(
        409,
        'IN_GEBRUIK',
        'Dit account staat in de geschiedenis van een rooster of van de instellingen. Het kan daarom niet worden verwijderd. Schakel het uit. Dan kan niemand er meer mee inloggen.'
      );
    }
    const eigen = db
      .prepare(`DELETE FROM dienstrooster_audit_log WHERE actor_id = ? AND entiteit = 'person' AND entiteit_id = ?`)
      .run(targetId, targetId).changes;
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(targetId);
    audit(actorId, targetId, { wijziging: 'account verwijderd door beheerder', codenaam: target.codenaam, rol: target.rol, eigen_wijzigingen_verwijderd: eigen }, 'DELETE');
    return { ok: true };
  })();
}
