/**
 * Settings the operator changes from the app instead of the server's .env
 * (dienstrooster_app_setting). For now only the mail account the
 * verzendlijst goes out from (lib/verzendlijstMail.ts), because once the
 * app runs on a ward server, the person running it may not be able to
 * edit files there.
 *
 * The app password is stored encrypted (lib/settingsCrypto.ts) and never
 * sent back to the browser.
 */

import { db } from '@/db/client';
import { decryptSetting, encryptSetting } from './settingsCrypto';

const GEBRUIKER = 'mail.gebruiker';
const WACHTWOORD = 'mail.wachtwoord';
const AAN = 'mail.verzendlijst_aan';

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

export function saveMailSettings(settings: { gebruiker: string; wachtwoord: string; verzendlijstAan: string }, actorId: string): void {
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
  })();
}

export function deleteMailSettings(): boolean {
  const removed = db
    .prepare(`DELETE FROM dienstrooster_app_setting WHERE sleutel IN (?, ?, ?)`)
    .run(GEBRUIKER, WACHTWOORD, AAN);
  return removed.changes > 0;
}
