/**
 * Settings the operator changes from the app instead of the server's .env
 * (dienstrooster_app_setting): the mail account the verzendlijst goes out
 * from (lib/verzendlijstMail.ts), because once the app runs on a ward
 * server, the person running it may not be able to edit files there, and
 * the roster office's address for the swap dialog (getSwapContacts).
 *
 * The app password is stored encrypted (lib/settingsCrypto.ts) and never
 * sent back to the browser.
 */

import { db } from '@/db/client';
import { decryptSetting, encryptSetting } from './settingsCrypto';

const GEBRUIKER = 'mail.gebruiker';
const WACHTWOORD = 'mail.wachtwoord';
const AAN = 'mail.verzendlijst_aan';
const LAATSTE_FOUT = 'mail.laatste_fout';
const ROOSTERBUREAU = 'ruil.adres_roosterbureau';

/**
 * The last time sending failed, kept until a send succeeds again (or the
 * settings change), so the planner sees on the period page that mail is
 * not going out, instead of hearing it from someone who got nothing.
 */
export interface MailFailure {
  /** ISO timestamp. */
  op: string;
  /** Dutch explanation (lib/verzendlijstMail.ts explainSmtpError). */
  melding: string;
  /** VerzendlijstSoort of what failed. */
  soort: string;
  automatisch: boolean;
}

export interface StoredMailSettings {
  gebruiker: string;
  /** null when stored but unreadable (the session secret changed). */
  wachtwoord: string | null;
  verzendlijstAan: string;
}

function get(sleutel: string): string | undefined {
  return (
    db.prepare('SELECT waarde FROM dienstrooster_app_setting WHERE sleutel = ?').get(sleutel) as
      | { waarde: string }
      | undefined
  )?.waarde;
}

/** The mail settings saved in the app, or null when there are none. */
export function getStoredMailSettings(): StoredMailSettings | null {
  const gebruiker = get(GEBRUIKER);
  const wachtwoord = get(WACHTWOORD);
  const verzendlijstAan = get(AAN);
  if (!gebruiker || !wachtwoord || !verzendlijstAan) return null;
  return { gebruiker, wachtwoord: decryptSetting(wachtwoord), verzendlijstAan };
}

export function recordMailFailure(failure: MailFailure): void {
  db.prepare(
    `INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op, gewijzigd_door)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde, gewijzigd_op = excluded.gewijzigd_op,
       gewijzigd_door = NULL`
  ).run(LAATSTE_FOUT, JSON.stringify(failure), failure.op);
}

export function clearMailFailure(): void {
  db.prepare('DELETE FROM dienstrooster_app_setting WHERE sleutel = ?').run(LAATSTE_FOUT);
}

export function getMailFailure(): MailFailure | null {
  const raw = get(LAATSTE_FOUT);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MailFailure;
  } catch {
    return null;
  }
}

export function saveMailSettings(settings: { gebruiker: string; wachtwoord: string; verzendlijstAan: string }, actorId: string | null): void {
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op, gewijzigd_door)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde, gewijzigd_op = excluded.gewijzigd_op,
       gewijzigd_door = excluded.gewijzigd_door`
  );
  db.transaction(() => {
    upsert.run(GEBRUIKER, settings.gebruiker, now, actorId);
    upsert.run(WACHTWOORD, encryptSetting(settings.wachtwoord), now, actorId);
    upsert.run(AAN, settings.verzendlijstAan, now, actorId);
    // New settings, so an earlier failure says nothing about them any more.
    clearMailFailure();
  })();
}

export function deleteMailSettings(): boolean {
  const removed = db
    .prepare(`DELETE FROM dienstrooster_app_setting WHERE sleutel IN (?, ?, ?, ?)`)
    .run(GEBRUIKER, WACHTWOORD, AAN, ROOSTERBUREAU);
  clearMailFailure();
  return removed.changes > 0;
}

export function getRoosterbureau(): string | null {
  return get(ROOSTERBUREAU) ?? null;
}

/** Saved with the mail settings; null removes it. */
export function setRoosterbureau(adres: string | null, actorId: string | null): void {
  if (!adres) {
    db.prepare('DELETE FROM dienstrooster_app_setting WHERE sleutel = ?').run(ROOSTERBUREAU);
    return;
  }
  db.prepare(
    `INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op, gewijzigd_door)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde, gewijzigd_op = excluded.gewijzigd_op,
       gewijzigd_door = excluded.gewijzigd_door`
  ).run(ROOSTERBUREAU, adres, new Date().toISOString(), actorId);
}

/**
 * Where a participant passes on a swap the app can't make (the swap
 * dialog): the app only swaps one shift for one of the same kind, any other
 * trade is agreed between colleagues and then reported to the planner (the
 * flow mailbox the verzendlijst goes to) and the roster office. Kept in the
 * app, never in code: they are the ward's own addresses, and the
 * repository is public.
 */
export function getSwapContacts(): { planner: string | null; roosterbureau: string | null } {
  return { planner: get(AAN) ?? null, roosterbureau: getRoosterbureau() };
}
