/**
 * Opens a backup file (lib/dbBackupBestand.ts) outside the app, for when the
 * app itself can't start: writes the database inside it to a file of its
 * own. Put that file in place of rooster.db while the app is stopped
 * (README, "Een back-up terugzetten zonder de app").
 *
 * Usage: npx tsx scripts/back-up-openen.ts <back-up.drbackup> <uit.db>
 *
 * Asks for the backup password on the terminal; with no terminal it reads
 * BACKUP_WACHTWOORD, never an argument (every process on the host could
 * read that). Touches no database of the app.
 */

import fs from 'fs';
import { BackupBestandFout, openBackupBestand } from '../lib/dbBackupBestand';
import { readBackupPassword } from './hiddenPrompt';

async function main() {
  const [bron, doel] = process.argv.slice(2);
  if (!bron || !doel) {
    console.error('Gebruik: npx tsx scripts/back-up-openen.ts <back-up.drbackup> <uit.db>');
    process.exit(2);
  }
  if (fs.existsSync(doel)) {
    console.error(`${doel} bestaat al. Kies een naam die nog niet bestaat; er is niets overschreven.`);
    process.exit(1);
  }
  const bestand = fs.readFileSync(bron);
  try {
    const { kop, database } = openBackupBestand(bestand, await readBackupPassword());
    fs.writeFileSync(doel, database, { flag: 'wx' });
    console.log(`Back-up van ${kop.gemaakt_op} (versie ${kop.app_versie}) geschreven naar ${doel}.`);
  } catch (error) {
    if (error instanceof BackupBestandFout) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

void main();
