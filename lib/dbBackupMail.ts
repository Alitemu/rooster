/**
 * The backup that leaves the server: once a day, when the database changed
 * (or a week went by without one), an encrypted copy (lib/dbBackupBestand.ts)
 * goes by mail to the address the beheerder set. A Power Automate flow puts
 * it in OneDrive (docs/backup-power-automate.md). The daily copy next to the
 * database (lib/dbBackup.ts) is lost with the server; this one is not.
 *
 * Set in the app by the beheerder ("Back-up" on the period list): the address
 * and the backup password, the latter stored encrypted like the Gmail app
 * password (lib/settingsCrypto.ts). The mail goes out from the Gmail account
 * of Mailinstellingen.
 *
 * What was sent and what went wrong is kept in a file next to the backups,
 * not in the database: a status row in the database would change the
 * database every day, and "only when it changed" would never hold.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db, dbFilePath } from '@/db/client';
import packageJson from '@/package.json';
import { decryptSetting, encryptSetting } from './settingsCrypto';
import { backupBestandsnaam, maakBackupBestand } from './dbBackupBestand';
import { localIsoDate } from './localDate';
import { sendDirectMail, verzendlijstMailConfigured } from './verzendlijstMail';

export const BACKUP_ONDERWERP = 'DIENSTROOSTER-BACKUP';
/** Gmail takes 25 MB per mail, and an attachment grows by a third on the way (base64). */
export const MAX_BACKUP_BYTES = 18 * 1024 * 1024;
/** An unchanged database still goes out after this many days, so the flow's check sees the app is alive. */
export const HARTSLAG_DAGEN = 7;

export const BACKUP_MAIL_STATUS_PAD = path.join(path.dirname(dbFilePath), 'backups', 'mail-status.json');

const AAN = 'backup.aan';
const WACHTWOORD = 'backup.wachtwoord';

export interface BackupMailStatus {
  /** sha256 of the database that went out last. */
  hash: string | null;
  /** ISO timestamp of the last mail that went out. */
  verstuurd_op: string | null;
  bestand: string | null;
  /** The day (YYYY-MM-DD, on the ward) the database was last looked at, sent or not. */
  gecontroleerd_dag: string | null;
  /** The last failure, until a backup goes out again. */
  fout: { op: string; melding: string } | null;
}

const LEEG: BackupMailStatus = { hash: null, verstuurd_op: null, bestand: null, gecontroleerd_dag: null, fout: null };

export function leesBackupMailStatus(pad: string = BACKUP_MAIL_STATUS_PAD): BackupMailStatus {
  try {
    return { ...LEEG, ...(JSON.parse(fs.readFileSync(pad, 'utf8')) as Partial<BackupMailStatus>) };
  } catch {
    return { ...LEEG };
  }
}

function schrijfStatus(status: BackupMailStatus, pad: string): void {
  fs.mkdirSync(path.dirname(pad), { recursive: true });
  const tijdelijk = `${pad}.bezig`;
  fs.writeFileSync(tijdelijk, JSON.stringify(status, null, 2));
  fs.renameSync(tijdelijk, pad);
}

/** After a restore the database is another one: the next run sends it, whatever was sent before. */
export function vergeetLaatsteBackup(pad: string = BACKUP_MAIL_STATUS_PAD): void {
  schrijfStatus({ ...leesBackupMailStatus(pad), hash: null, gecontroleerd_dag: null }, pad);
}

function get(sleutel: string): string | undefined {
  return (db.prepare('SELECT waarde FROM dienstrooster_app_setting WHERE sleutel = ?').get(sleutel) as { waarde: string } | undefined)?.waarde;
}

export interface BackupInstellingen {
  aan: string;
  /** null when stored but unreadable (the session secret changed, e.g. after a restore on a new server). */
  wachtwoord: string | null;
}

export function getBackupInstellingen(): BackupInstellingen | null {
  const aan = get(AAN);
  const wachtwoord = get(WACHTWOORD);
  if (!aan || !wachtwoord) return null;
  return { aan, wachtwoord: decryptSetting(wachtwoord) };
}

export function saveBackupInstellingen(instellingen: { aan: string; wachtwoord: string }, actorId: string | null): void {
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op, gewijzigd_door)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde, gewijzigd_op = excluded.gewijzigd_op,
       gewijzigd_door = excluded.gewijzigd_door`
  );
  db.transaction(() => {
    upsert.run(AAN, instellingen.aan, now, actorId);
    upsert.run(WACHTWOORD, encryptSetting(instellingen.wachtwoord), now, actorId);
  })();
}

export function deleteBackupInstellingen(): boolean {
  return db.prepare('DELETE FROM dienstrooster_app_setting WHERE sleutel IN (?, ?)').run(AAN, WACHTWOORD).changes > 0;
}

/** What the beheerder sees: whether it is set up, whether it can work, when the last one went out and what went wrong. */
export function backupMailOverzicht(pad: string = BACKUP_MAIL_STATUS_PAD) {
  const instellingen = getBackupInstellingen();
  const status = leesBackupMailStatus(pad);
  return {
    ingesteld: instellingen !== null,
    aan: instellingen?.aan ?? null,
    wachtwoord_leesbaar: instellingen ? instellingen.wachtwoord !== null : null,
    mail_ingesteld: verzendlijstMailConfigured(),
    verstuurd_op: status.verstuurd_op,
    bestand: status.bestand,
    fout: status.fout,
  };
}

export type BackupMailUitkomst =
  | { uitkomst: 'VERSTUURD'; bestand: string; bytes: number }
  | { uitkomst: 'ONGEWIJZIGD' | 'AL_GECONTROLEERD' | 'NIET_INGESTELD' }
  | { uitkomst: 'MISLUKT'; melding: string };

/** A consistent copy of the live database while the app keeps running (VACUUM INTO, as lib/dbBackup.ts). */
function databaseKopie(werkMap: string): Buffer {
  fs.mkdirSync(werkMap, { recursive: true });
  const tijdelijk = path.join(werkMap, `mail-kopie-${crypto.randomUUID()}.db`);
  try {
    db.prepare('VACUUM INTO ?').run(tijdelijk);
    return fs.readFileSync(tijdelijk);
  } finally {
    fs.rmSync(tijdelijk, { force: true });
  }
}

const dagenTussen = (van: string, tot: Date) => (tot.getTime() - new Date(van).getTime()) / 86_400_000;

/**
 * The hourly run (instrumentation-node.ts): at most once a day, and only when
 * the database changed since the last backup that went out or HARTSLAG_DAGEN
 * passed. `dwingen` ("Nu een back-up versturen") skips both checks. A failure
 * is kept for the beheerder and tried again the next hour.
 */
export async function runBackupMail(
  now: Date = new Date(),
  opties: { dwingen?: boolean; statusPad?: string; maxBytes?: number } = {}
): Promise<BackupMailUitkomst> {
  const pad = opties.statusPad ?? BACKUP_MAIL_STATUS_PAD;
  const instellingen = getBackupInstellingen();
  if (!instellingen) return { uitkomst: 'NIET_INGESTELD' };
  const status = leesBackupMailStatus(pad);
  const vandaag = localIsoDate(now);
  if (!opties.dwingen && status.gecontroleerd_dag === vandaag) return { uitkomst: 'AL_GECONTROLEERD' };

  const mislukt = (melding: string): BackupMailUitkomst => {
    schrijfStatus({ ...status, fout: { op: now.toISOString(), melding } }, pad);
    return { uitkomst: 'MISLUKT', melding };
  };

  if (instellingen.wachtwoord === null) {
    return mislukt('Het back-upwachtwoord is niet meer te lezen, bijvoorbeeld na het terugzetten op een nieuwe server. Vul het opnieuw in bij Back-up.');
  }
  if (!verzendlijstMailConfigured()) {
    return mislukt('Versturen is niet ingesteld. Stel eerst het Gmail-account in bij Mailinstellingen.');
  }

  let database: Buffer;
  try {
    database = databaseKopie(path.dirname(pad));
  } catch (error) {
    console.error('[back-up-mail] kopie van de database mislukt', error);
    return mislukt('Er kon geen kopie van de database gemaakt worden. Is de schijf vol?');
  }
  const hash = crypto.createHash('sha256').update(database).digest('hex');
  const recentVerstuurd = status.verstuurd_op !== null && dagenTussen(status.verstuurd_op, now) < HARTSLAG_DAGEN;
  if (!opties.dwingen && hash === status.hash && recentVerstuurd) {
    schrijfStatus({ ...status, gecontroleerd_dag: vandaag }, pad);
    return { uitkomst: 'ONGEWIJZIGD' };
  }

  const bestand = maakBackupBestand(database, instellingen.wachtwoord, { app_versie: packageJson.version, gemaakt_op: now.toISOString() });
  if (bestand.length > (opties.maxBytes ?? MAX_BACKUP_BYTES)) {
    return mislukt('De back-up is te groot om te mailen (meer dan 18 MB). Neem contact op met wie de app onderhoudt.');
  }
  const naam = backupBestandsnaam(now);
  const verstuurd = await sendDirectMail({
    to: instellingen.aan,
    subject: `${BACKUP_ONDERWERP} ${vandaag}`,
    text:
      `In de bijlage staat een versleutelde back-up van Dienstrooster van ${vandaag}.\n\n` +
      'Je opent hem alleen met het back-upwachtwoord. Terugzetten doe je in de app, als beheerder, bij Back-up.\n\n' +
      'Dit bericht is automatisch verstuurd. De stroom in Power Automate zet de bijlage in OneDrive.',
    attachments: [{ filename: naam, content: bestand, contentType: 'application/octet-stream' }],
  });
  if (!verstuurd.ok) return mislukt(verstuurd.message);

  schrijfStatus({ hash, verstuurd_op: now.toISOString(), bestand: naam, gecontroleerd_dag: vandaag, fout: null }, pad);
  return { uitkomst: 'VERSTUURD', bestand: naam, bytes: bestand.length };
}
