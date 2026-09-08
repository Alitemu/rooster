/**
 * Optional automated first-run password claim for the PLANNER account,
 * driven by the SEED_PLANNER_PASSWORD env var (see .env.example).
 *
 * scripts/seed.ts already applies SEED_PLANNER_PASSWORD directly when it
 * creates the planner account (SEED_ON_START=true path), so this script's
 * main remaining use is a deployment with SEED_ON_START=false - where the
 * planner account exists with no password yet (created some other way)
 * and this lets an operator set it from .env instead of the interactive
 * /planner/login "first run" form - which is gitignored, so the password
 * itself never enters this repo. That's the same reason
 * app/api/auth/first-run-setup/route.ts never sets a password directly: a
 * fixed password checked into git is a real credential, not a placeholder.
 *
 * Idempotent and safe to run on every boot: only ever touches an account
 * whose wachtwoord_hash is still NULL - the same guarantee
 * first-run-setup/route.ts gives interactively. Once a password is set
 * (this way, or through the form, or by scripts/seed.ts), this script
 * can't touch that account again.
 *
 * Usage: tsx scripts/claim-password.ts <CODENAAM> [password]
 *
 * The password can be passed as a second argument, or omitted and read
 * from SEED_PLANNER_PASSWORD instead - the latter is what
 * docker-entrypoint.sh uses, since a CLI argument is visible to any other
 * process on the host via `ps aux` for as long as this process runs, while
 * an environment variable is not.
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
  const [codenaam, argPassword] = process.argv.slice(2);
  const password = argPassword || process.env.SEED_PLANNER_PASSWORD;

  if (!codenaam || !password) {
    console.error('Usage: tsx scripts/claim-password.ts <CODENAAM> [password] (or set SEED_PLANNER_PASSWORD)');
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
