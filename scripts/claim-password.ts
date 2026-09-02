/**
 * Optional automated first-run password claim for ADMIN/PLANNER, driven by
 * the SEED_ADMIN_PASSWORD / SEED_PLANNER_PASSWORD env vars (see
 * .env.example).
 *
 * Exists so an operator who wants to skip the interactive /planner/login
 * "first run" form can do so via their own .env instead - which is
 * gitignored, so the password itself never enters this repo. That's the
 * same reason scripts/seed.ts and app/api/auth/first-run-setup/route.ts
 * never set a password directly: a fixed password checked into git is a
 * real credential, not a placeholder.
 *
 * Idempotent and safe to run on every boot: only ever touches an account
 * whose wachtwoord_hash is still NULL - the same guarantee
 * first-run-setup/route.ts gives interactively. Once a password is set
 * (this way, or through the form), this script can't touch that account
 * again.
 *
 * Usage: tsx scripts/claim-password.ts <CODENAAM> <password>
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { hashPassword, validatePasswordStrength } from '../lib/auth';

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

async function main() {
  const [codenaam, password] = process.argv.slice(2);

  if (!codenaam || !password) {
    console.error('Usage: tsx scripts/claim-password.ts <CODENAAM> <password>');
    process.exit(1);
  }

  const passwordErrors = validatePasswordStrength(password);
  if (passwordErrors.length > 0) {
    console.error(`${codenaam}: wachtwoord voldoet niet aan de eisen (${passwordErrors.join(', ')}) - overgeslagen.`);
    process.exit(1);
  }

  const db = new Database(resolveDbPath());
  try {
    const person = db
      .prepare(
        `SELECT id, wachtwoord_hash FROM dienstrooster_person
         WHERE codenaam = ? AND rol IN ('ADMIN', 'PLANNER')`
      )
      .get(codenaam) as { id: string; wachtwoord_hash: string | null } | undefined;

    if (!person) {
      console.log(`${codenaam}: account bestaat niet - overgeslagen.`);
      return;
    }
    if (person.wachtwoord_hash !== null) {
      console.log(`${codenaam}: heeft al een wachtwoord - overgeslagen.`);
      return;
    }

    const passwordHash = await hashPassword(password);
    const result = db
      .prepare(`UPDATE dienstrooster_person SET wachtwoord_hash = ? WHERE id = ? AND wachtwoord_hash IS NULL`)
      .run(passwordHash, person.id);

    console.log(result.changes > 0 ? `${codenaam}: wachtwoord ingesteld.` : `${codenaam}: al door iets anders geclaimd - overgeslagen.`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('claim-password mislukt:', error);
  process.exit(1);
});
