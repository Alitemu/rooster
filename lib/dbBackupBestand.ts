/**
 * The encrypted backup file the app mails to the beheerder (lib/dbBackupMail.ts)
 * and takes back in "Back-up terugzetten" (lib/dbBackupTerugzetten.ts).
 *
 * The file passes through Gmail (whose Sent folder keeps every one), a
 * mailbox and OneDrive, none of which should be able to read it. So the
 * database is compressed and then encrypted with AES-256-GCM under a key
 * derived from the backup password with scrypt. The password is the
 * beheerder's own, not the session secret: a backup must still open on a
 * new server, after the old one and its secret are gone.
 *
 * Layout: MAGIC | header length (uint32 BE) | header (JSON) | ciphertext | tag (16).
 * The header is readable without the password (what the restore page shows
 * before asking for it) and is authenticated as the cipher's additional
 * data, so changing a byte of it fails like a wrong password does.
 */

import crypto from 'crypto';
import zlib from 'zlib';
import { localIsoMinute } from './localDate';

export const BACKUP_MAGIC = Buffer.from('DIENSTROOSTER-BACKUP\n', 'ascii');
export const BACKUP_EXTENSIE = '.drbackup';
const FORMAAT = 1;
const TAG_LENGTE = 16;

/** scrypt at 2^15: about 0.1 s and 32 MB per try, which makes guessing a password expensive. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
/** A header may ask for more work than this, but it isn't done: a crafted file must not tie up the server. */
const SCRYPT_N_MAX = 1 << 17;

/** A database larger than this after decompressing is not ours (a zip bomb, or something else entirely). */
const MAX_DATABASE_BYTES = 1024 * 1024 * 1024;

export const MIN_WACHTWOORD_LENGTE = 12;

/** A wrong password and a changed byte fail alike. The case of a letter is what went wrong in practice (0.904.0). */
export const WACHTWOORD_KLOPT_NIET =
  'Het wachtwoord klopt niet of het bestand is beschadigd. Let op hoofdletters en kleine letters.';

export interface BackupKop {
  formaat: number;
  /** package.json's version of the app that made it. */
  app_versie: string;
  /** ISO timestamp. */
  gemaakt_op: string;
  kdf: { naam: 'scrypt'; N: number; r: number; p: number; zout: string };
  iv: string;
}

/** Why a file could not be read, in words for the beheerder. */
export class BackupBestandFout extends Error {}

function sleutel(wachtwoord: string, zout: Buffer, kdf: { N: number; r: number; p: number }): Buffer {
  return crypto.scryptSync(wachtwoord.normalize('NFC'), zout, 32, { ...kdf, maxmem: 256 * kdf.N * kdf.r + 1024 * 1024 });
}

export function maakBackupBestand(database: Buffer, wachtwoord: string, meta: { app_versie: string; gemaakt_op: string }): Buffer {
  const zout = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const kop: BackupKop = {
    formaat: FORMAAT,
    app_versie: meta.app_versie,
    gemaakt_op: meta.gemaakt_op,
    kdf: { naam: 'scrypt', ...SCRYPT, zout: zout.toString('base64') },
    iv: iv.toString('base64'),
  };
  const kopBytes = Buffer.from(JSON.stringify(kop), 'utf8');
  const lengte = Buffer.alloc(4);
  lengte.writeUInt32BE(kopBytes.length);
  const voorwerk = Buffer.concat([BACKUP_MAGIC, lengte, kopBytes]);

  const cipher = crypto.createCipheriv('aes-256-gcm', sleutel(wachtwoord, zout, SCRYPT), iv, { authTagLength: TAG_LENGTE });
  cipher.setAAD(voorwerk);
  const versleuteld = Buffer.concat([cipher.update(zlib.gzipSync(database)), cipher.final()]);
  return Buffer.concat([voorwerk, versleuteld, cipher.getAuthTag()]);
}

/** The header and where the encrypted part starts, without the password. Throws BackupBestandFout. */
export function leesBackupKop(bestand: Buffer): { kop: BackupKop; voorwerk: Buffer } {
  const geenBackup = new BackupBestandFout('Dit is geen back-upbestand van Dienstrooster.');
  if (bestand.length < BACKUP_MAGIC.length + 4 || !bestand.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw geenBackup;
  const lengte = bestand.readUInt32BE(BACKUP_MAGIC.length);
  const start = BACKUP_MAGIC.length + 4;
  if (lengte > 4096 || start + lengte + TAG_LENGTE > bestand.length) throw geenBackup;
  let kop: BackupKop;
  try {
    kop = JSON.parse(bestand.subarray(start, start + lengte).toString('utf8')) as BackupKop;
  } catch {
    throw geenBackup;
  }
  if (kop?.formaat !== FORMAAT) {
    throw new BackupBestandFout('Dit back-upbestand is gemaakt door een nieuwere versie van Dienstrooster. Werk de app eerst bij.');
  }
  const { kdf } = kop;
  if (
    kdf?.naam !== 'scrypt' ||
    !Number.isInteger(kdf.N) || kdf.N < 2 || kdf.N > SCRYPT_N_MAX || (kdf.N & (kdf.N - 1)) !== 0 ||
    !Number.isInteger(kdf.r) || kdf.r < 1 || kdf.r > 16 ||
    !Number.isInteger(kdf.p) || kdf.p < 1 || kdf.p > 4 ||
    typeof kdf.zout !== 'string' || typeof kop.iv !== 'string' ||
    typeof kop.app_versie !== 'string' || typeof kop.gemaakt_op !== 'string'
  ) {
    throw geenBackup;
  }
  return { kop, voorwerk: bestand.subarray(0, start + lengte) };
}

/** The database inside a backup file. Throws BackupBestandFout. */
export function openBackupBestand(bestand: Buffer, wachtwoord: string): { kop: BackupKop; database: Buffer } {
  const { kop, voorwerk } = leesBackupKop(bestand);
  let gzip: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', sleutel(wachtwoord, Buffer.from(kop.kdf.zout, 'base64'), kop.kdf), Buffer.from(kop.iv, 'base64'), {
      authTagLength: TAG_LENGTE,
    });
    decipher.setAAD(voorwerk);
    decipher.setAuthTag(bestand.subarray(bestand.length - TAG_LENGTE));
    gzip = Buffer.concat([decipher.update(bestand.subarray(voorwerk.length, bestand.length - TAG_LENGTE)), decipher.final()]);
  } catch {
    // GCM cannot tell a wrong password from a changed byte, and neither can we.
    throw new BackupBestandFout(WACHTWOORD_KLOPT_NIET);
  }
  try {
    return { kop, database: zlib.gunzipSync(gzip, { maxOutputLength: MAX_DATABASE_BYTES }) };
  } catch {
    throw new BackupBestandFout('Het back-upbestand is beschadigd.');
  }
}

/** The file name a backup goes out under: sorting by name is sorting by time. */
export function backupBestandsnaam(moment: Date): string {
  return `dienstrooster-backup-${localIsoMinute(moment).replace('T', '-').replace(':', '')}${BACKUP_EXTENSIE}`;
}
