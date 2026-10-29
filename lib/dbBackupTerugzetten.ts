/**
 * "Back-up terugzetten": the beheerder uploads a backup file (lib/dbBackupBestand.ts)
 * with its password, and the live database becomes the one inside it,
 * while the app keeps running.
 *
 * In this order, and nothing changes until the last step:
 * 1. no generation runs (its answer would land in the restored database);
 * 2. the file opens with the password and comes from this version of the
 *    app or an older one (a newer one may hold what this one doesn't know);
 * 3. the database inside is whole (integrity_check), is a Dienstrooster
 *    database, and has a beheerder who can log in: otherwise the restore
 *    would lock everyone out;
 * 4. a copy of the database as it is now goes next to the daily backups
 *    (voor-terugzetten-...), so a wrong choice can be undone;
 * 5. SQLite's own backup API copies the file into the live database. It
 *    takes the write lock for the whole copy, so a save in the meantime
 *    waits and then sees the restored database; WAL mode stays.
 *
 * A backup from an older version is then brought up to date with the step
 * every start runs (scripts/seed.ts --schema-only).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { db, dbFilePath } from '@/db/client';
import packageJson from '@/package.json';
import { BackupBestandFout, openBackupBestand, type BackupKop } from './dbBackupBestand';
import { DB_BACKUP_DIR } from './dbBackup';
import { BACKUP_MAIL_STATUS_PAD, vergeetLaatsteBackup } from './dbBackupMail';
import { localIsoMinute } from './localDate';
import { hasAnyRunningJob } from './rosterGenerationJobs';
import { aiosGeneratieLooptErgens } from './aiosGenereren';

/** The word the beheerder types to confirm (the route and the dialog). */
export const BEVESTIGING = 'TERUGZETTEN';

export class TerugzetFout extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** -1, 0 or 1, for versions of three numbers (package.json). */
export function vergelijkVersies(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Why a database can't be restored, or null when it can. */
function controleer(pad: string): string | null {
  let kandidaat: Database.Database;
  try {
    kandidaat = new Database(pad, { readonly: true, fileMustExist: true });
  } catch {
    return 'In de back-up zit geen database die te openen is.';
  }
  try {
    if (kandidaat.pragma('integrity_check', { simple: true }) !== 'ok') return 'De database in de back-up is beschadigd.';
    const tabel = (naam: string) => kandidaat.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(naam);
    if (!tabel('dienstrooster_person') || !tabel('dienstrooster_app_setting')) return 'De back-up bevat geen database van Dienstrooster.';
    const beheerder = kandidaat
      .prepare(`SELECT 1 FROM dienstrooster_person WHERE rol = 'ADMIN' AND actief = 1 AND wachtwoord_hash IS NOT NULL LIMIT 1`)
      .get();
    if (!beheerder) return 'In deze back-up kan geen beheerder inloggen. Na het terugzetten zou niemand meer bij de app kunnen.';
    return null;
  } catch {
    return 'De back-up bevat geen database van Dienstrooster.';
  } finally {
    kandidaat.close();
  }
}

/** The step every start runs (docker-entrypoint.sh): new tables and columns, no data. */
function werkSchemaBij(): Promise<boolean> {
  return new Promise((resolve) => {
    const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const kind = spawn(tsx, ['scripts/seed.ts', '--schema-only'], { stdio: 'inherit' });
    kind.on('exit', (code) => resolve(code === 0));
    kind.on('error', (error) => {
      console.error('[terugzetten] schema bijwerken niet gestart', error);
      resolve(false);
    });
  });
}

export interface TerugzetUitkomst {
  kop: BackupKop;
  /** The copy of the database as it was just before. */
  veiligheidskopie: string;
  /** false when a backup from an older version could not be brought up to date: the next start does it. */
  schemaBijgewerkt: boolean;
}

export async function zetBackupTerug(
  bestand: Buffer,
  wachtwoord: string,
  opties: {
    doelDb?: Database.Database;
    doelPad?: string;
    kopieMap?: string;
    statusPad?: string;
    appVersie?: string;
    schemaBijwerken?: () => Promise<boolean>;
  } = {}
): Promise<TerugzetUitkomst> {
  const doelDb = opties.doelDb ?? db;
  const doelPad = opties.doelPad ?? dbFilePath;
  const kopieMap = opties.kopieMap ?? DB_BACKUP_DIR;
  const appVersie = opties.appVersie ?? packageJson.version;

  if (hasAnyRunningJob() || aiosGeneratieLooptErgens()) {
    throw new TerugzetFout('Er wordt nu een rooster gemaakt. Wacht tot dat klaar is en probeer het dan opnieuw.', 409);
  }

  let kop: BackupKop;
  let database: Buffer;
  try {
    ({ kop, database } = openBackupBestand(bestand, wachtwoord));
  } catch (error) {
    if (error instanceof BackupBestandFout) throw new TerugzetFout(error.message, 400);
    throw error;
  }
  if (vergelijkVersies(kop.app_versie, appVersie) > 0) {
    throw new TerugzetFout(
      `Deze back-up is gemaakt door versie ${kop.app_versie}, nieuwer dan deze app (${appVersie}). Werk de app eerst bij.`,
      400
    );
  }

  fs.mkdirSync(kopieMap, { recursive: true });
  const kandidaat = path.join(kopieMap, `terugzetten-${crypto.randomUUID()}.db`);
  try {
    fs.writeFileSync(kandidaat, database);
    const bezwaar = controleer(kandidaat);
    if (bezwaar) throw new TerugzetFout(bezwaar, 400);

    const veiligheidskopie = path.join(kopieMap, `voor-terugzetten-${localIsoMinute().replace('T', '-').replace(':', '')}-${crypto.randomUUID().slice(0, 8)}.db`);
    doelDb.prepare('VACUUM INTO ?').run(veiligheidskopie);

    const bron = new Database(kandidaat, { readonly: true });
    try {
      // One step for the whole file: the live database stays locked from the first page to the last.
      await bron.backup(doelPad, { progress: () => 0x7fffffff });
    } finally {
      bron.close();
    }

    const schemaBijgewerkt =
      vergelijkVersies(kop.app_versie, appVersie) === 0 ? true : await (opties.schemaBijwerken ?? werkSchemaBij)();
    vergeetLaatsteBackup(opties.statusPad ?? BACKUP_MAIL_STATUS_PAD);
    return { kop, veiligheidskopie, schemaBijgewerkt };
  } finally {
    fs.rmSync(kandidaat, { force: true });
  }
}
