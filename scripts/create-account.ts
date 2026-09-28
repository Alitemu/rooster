/**
 * Adds a staff account on the server: a beheerder (ADMIN, the default) or a
 * planner. Meant for the first beheerder; after that, a beheerder adds
 * accounts in the app ("Accounts beheren" on the period list).
 *
 * The password is asked twice without showing it (scripts/hiddenPrompt.ts)
 * and is the account's own, so no change is forced at the first login. An
 * existing planner account is made beheerder only with --beheerder, and keeps
 * its password.
 *
 * The codenaam is typed on the server, not stored anywhere in the code.
 *
 * Usage (as the app's own user, so the database files stay its own):
 *   docker compose exec -u node web npx tsx scripts/create-account.ts <CODENAAM>
 *   docker compose exec -u node web npx tsx scripts/create-account.ts <CODENAAM> --planner
 *   docker compose exec -u node web npx tsx scripts/create-account.ts <CODENAAM> --beheerder   (bestaande planner)
 */

import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { hashPassword, validatePasswordStrength } from '../lib/auth';
import { validateCodenaam } from '../lib/codenaam';
import { DEFAULT_TEST_PASSWORD } from '../lib/seedPassword';
import { readNewPassword } from './hiddenPrompt';

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

function audit(db: Database.Database, personId: string, wijziging: Record<string, unknown>) {
  db.prepare(
    `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, nieuw_json, tijdstip)
     VALUES (?, ?, 'person', ?, 'UPDATE', ?, ?)`
  ).run(crypto.randomUUID(), personId, personId, JSON.stringify(wijziging), new Date().toISOString());
}

async function main() {
  const args = process.argv.slice(2);
  const rol = args.includes('--planner') ? 'PLANNER' : 'ADMIN';
  const naam = validateCodenaam(args.find((a) => !a.startsWith('--')));
  if (!naam.valid) {
    console.error(`${naam.message}\nGebruik: npx tsx scripts/create-account.ts <CODENAAM> [--planner]`);
    process.exit(1);
  }

  const db = new Database(resolveDbPath());
  try {
    const existing = db
      .prepare('SELECT id, rol FROM dienstrooster_person WHERE codenaam = ? COLLATE NOCASE')
      .get(naam.codenaam) as { id: string; rol: string } | undefined;
    if (existing) {
      if (existing.rol === 'PLANNER' && args.includes('--beheerder')) {
        db.transaction(() => {
          db.prepare(`UPDATE dienstrooster_person SET rol = 'ADMIN', actief = 1 WHERE id = ?`).run(existing.id);
          audit(db, existing.id, { wijziging: 'beheerder gemaakt op de server' });
        })();
        console.log(`${naam.codenaam} is nu beheerder. Het wachtwoord is niet veranderd.`);
        return;
      }
      console.error(
        existing.rol === 'PLANNER'
          ? `${naam.codenaam} bestaat al als planner. Er is niets veranderd. Wil je er een beheerder van maken, voeg dan --beheerder toe.`
          : `${naam.codenaam} bestaat al. Er is niets veranderd.`
      );
      process.exit(1);
    }

    const password = await readNewPassword();
    const problems = validatePasswordStrength(password);
    if (password === DEFAULT_TEST_PASSWORD) problems.push('Dit wachtwoord staat in de broncode en mag niet gebruikt worden');
    if (problems.length > 0) {
      console.error(`Niet aangemaakt:\n- ${problems.join('\n- ')}`);
      process.exit(1);
    }

    const hash = await hashPassword(password);
    const id = crypto.randomUUID();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op)
         VALUES (?, ?, ?, 1, ?, ?)`
      ).run(id, naam.codenaam, rol, hash, new Date().toISOString());
      audit(db, id, { wijziging: 'account aangemaakt op de server', rol });
    })();
    console.log(`${naam.codenaam} is aangemaakt als ${rol === 'ADMIN' ? 'beheerder' : 'planner'}. Log in op de gewone inlogpagina.`);
  } finally {
    db.close();
  }
}

main();
