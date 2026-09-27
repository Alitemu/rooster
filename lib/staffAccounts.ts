/**
 * The staff accounts (ADMIN and PLANNER), managed by an admin.
 *
 * An ADMIN can do everything a planner can, and here also: add a planner or
 * admin account, give an account a temporary password, turn off someone's
 * two-step verification and switch an account off. A temporary password
 * sets `wachtwoord_moet_wijzigen`, so the next login can only choose a new
 * one (like a login with the seed password): the admin knows the temporary
 * one, only its owner should know the one the account goes on with.
 *
 * An admin never manages their own account here (that is "Wachtwoord
 * wijzigen" and "Tweestapsverificatie"), so nobody can lock themselves out,
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

export interface StaffAccount {
  id: string;
  codenaam: string;
  rol: StaffRol;
  actief: boolean;
  tweestapsverificatie: boolean;
  wachtwoord_ingesteld: boolean;
  wachtwoord_moet_wijzigen: boolean;
}

export type AccountResult = { ok: true } | { ok: false; status: number; code: string; message: string };

const fail = (status: number, code: string, message: string): AccountResult => ({ ok: false, status, code, message });

export function listStaffAccounts(): StaffAccount[] {
  return (
    db
      .prepare(
        `SELECT id, codenaam, rol, actief, totp_secret, wachtwoord_hash, wachtwoord_moet_wijzigen
         FROM dienstrooster_person WHERE rol IN ('ADMIN', 'PLANNER') ORDER BY rol, codenaam`
      )
      .all() as Array<{
      id: string;
      codenaam: string;
      rol: StaffRol;
      actief: number;
      totp_secret: string | null;
      wachtwoord_hash: string | null;
      wachtwoord_moet_wijzigen: number;
    }>
  ).map((r) => ({
    id: r.id,
    codenaam: r.codenaam,
    rol: r.rol,
    actief: Boolean(r.actief),
    tweestapsverificatie: Boolean(r.totp_secret),
    wachtwoord_ingesteld: Boolean(r.wachtwoord_hash),
    wachtwoord_moet_wijzigen: Boolean(r.wachtwoord_moet_wijzigen),
  }));
}

/** Dutch reasons a password can't be used, empty when it can. */
export function temporaryPasswordProblems(password: unknown): string[] {
  if (typeof password !== 'string') return ['Wachtwoord is verplicht'];
  const problems = validatePasswordStrength(password);
  if (password === DEFAULT_TEST_PASSWORD) problems.push('Dit wachtwoord staat openbaar in de broncode');
  return problems;
}

function audit(actorId: string, targetId: string, wijziging: Record<string, unknown>) {
  db.prepare(
    `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, nieuw_json, tijdstip)
     VALUES (?, ?, 'person', ?, 'UPDATE', ?, ?)`
  ).run(crypto.randomUUID(), actorId, targetId, JSON.stringify(wijziging), new Date().toISOString());
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
      message: 'Je eigen account beheer je met Wachtwoord wijzigen en Tweestapsverificatie.',
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
  input: { codenaam: unknown; rol: unknown; wachtwoord: unknown }
): Promise<AccountResult & { id?: string }> {
  const naam = validateCodenaam(input.codenaam);
  if (!naam.valid) return fail(400, 'INVALID_CODENAAM', naam.message);
  if (input.rol !== 'ADMIN' && input.rol !== 'PLANNER') return fail(400, 'INVALID_ROL', 'Kies planner of beheerder');
  const problems = temporaryPasswordProblems(input.wachtwoord);
  if (problems.length > 0) return fail(400, 'WEAK_PASSWORD', problems.join(', '));
  if (db.prepare('SELECT 1 FROM dienstrooster_person WHERE codenaam = ?').get(naam.codenaam)) {
    return fail(409, 'CODENAAM_TAKEN', 'Deze codenaam is al in gebruik');
  }
  const hash = await hashPassword(input.wachtwoord as string);
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, wachtwoord_moet_wijzigen, aangemaakt_op)
       VALUES (?, ?, ?, 1, ?, 1, ?)`
    ).run(id, naam.codenaam, input.rol, hash, new Date().toISOString());
    audit(actorId, id, { wijziging: 'account aangemaakt', rol: input.rol });
  })();
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

export function disableStaffTotp(actorId: string, targetId: string): AccountResult {
  const target = staffTarget(actorId, targetId);
  if (isFailure(target)) return target;
  db.transaction(() => {
    db.prepare('UPDATE dienstrooster_person SET totp_secret = NULL WHERE id = ?').run(targetId);
    revokeAllSessions(targetId);
    audit(actorId, targetId, { wijziging: 'tweestapsverificatie uitgezet door beheerder', sessies_ingetrokken: true });
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
