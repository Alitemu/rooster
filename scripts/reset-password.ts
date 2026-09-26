/**
 * Sets a new password for one staff account, for when the planner has
 * forgotten theirs. There is no "forgot password" on the login page: the
 * app keeps no e-mail address to send a reset link to, and a way back
 * that anyone at the login screen could start would be a way in.
 *
 * Needs access to the server, like scripts/reset-totp.ts: it is the way
 * back for whoever runs the installation. It asks for the new password
 * twice without showing it (with no terminal, it reads NIEUW_WACHTWOORD
 * from the environment instead - never a command-line argument, which
 * every process on the host could read). The same rules apply as in the
 * app, and the password from the repository is refused. Every session of
 * the account is ended and the change is in the audit trail. Two-step
 * verification stays as it is; is the phone gone too, run reset-totp.
 *
 * Usage (as the app's own user, so the database files stay its own):
 *   docker compose exec -u node web npx tsx scripts/reset-password.ts <CODENAAM>
 *   npx tsx scripts/reset-password.ts <CODENAAM>          (next to the database)
 */

import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { hashPassword, validatePasswordStrength } from '../lib/auth';
import { DEFAULT_TEST_PASSWORD } from '../lib/seedPassword';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Same resolution as scripts/seed.ts / db/client.ts.
function resolveDbPath(): string {
  const raw = process.env.DATABASE_URL || 'file:./rooster.db';
  let filePath = raw;
  if (filePath.startsWith('file:')) {
    filePath = filePath.slice(5);
    if (filePath.startsWith('//')) filePath = filePath.slice(2);
  }
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(__dirname, '..', filePath);
}

/** Reads one line from the terminal without echoing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (char: string) => {
      for (const c of char) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(input);
          return;
        }
        if (c === '\u0003') {
          // Ctrl+C
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') input = input.slice(0, -1);
        else input += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const fromEnv = process.env.NIEUW_WACHTWOORD;
    if (!fromEnv) {
      console.error('Geen terminal: zet het nieuwe wachtwoord in NIEUW_WACHTWOORD.');
      process.exit(1);
    }
    return fromEnv;
  }
  const first = await askHidden('Nieuw wachtwoord: ');
  const second = await askHidden('Nog een keer: ');
  if (first !== second) {
    console.error('De twee wachtwoorden zijn niet gelijk. Er is niets veranderd.');
    process.exit(1);
  }
  return first;
}

async function main() {
  const [codenaam] = process.argv.slice(2);
  if (!codenaam) {
    console.error('Gebruik: npx tsx scripts/reset-password.ts <CODENAAM>');
    process.exit(1);
  }

  const db = new Database(resolveDbPath());
  try {
    const person = db
      .prepare(`SELECT id FROM dienstrooster_person WHERE codenaam = ? AND rol IN ('ADMIN', 'PLANNER')`)
      .get(codenaam) as { id: string } | undefined;
    if (!person) {
      console.error(`${codenaam}: geen planner met deze codenaam.`);
      process.exit(1);
    }

    const password = await readNewPassword();
    const problems = validatePasswordStrength(password);
    if (password === DEFAULT_TEST_PASSWORD) problems.push('Dit wachtwoord staat in de broncode en mag niet gebruikt worden');
    if (problems.length > 0) {
      console.error(`Niet veranderd:\n- ${problems.join('\n- ')}`);
      process.exit(1);
    }

    const hash = await hashPassword(password);
    db.transaction(() => {
      db.prepare(
        'UPDATE dienstrooster_person SET wachtwoord_hash = ?, sessie_versie = sessie_versie + 1 WHERE id = ?'
      ).run(hash, person.id);
      db.prepare(
        `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, nieuw_json, tijdstip)
         VALUES (?, ?, 'person', ?, 'UPDATE', ?, ?)`
      ).run(
        crypto.randomUUID(),
        person.id,
        person.id,
        JSON.stringify({ wijziging: 'wachtwoord opnieuw ingesteld op de server', sessies_ingetrokken: true }),
        new Date().toISOString()
      );
    })();
    console.log(`${codenaam}: het nieuwe wachtwoord is ingesteld. Overal waar ${codenaam} was ingelogd, is dat beëindigd.`);
  } finally {
    db.close();
  }
}

main();
