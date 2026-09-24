/**
 * Turns off two-step verification (TOTP) for one staff account, for when
 * its secret can no longer be read (lib/totpSecret.ts: a new SESSION_SECRET
 * or a lost .session_secret) or the phone with the codes is gone and the
 * planner cannot log in to turn it off themselves.
 *
 * Needs access to the server, which is the point: it is the way back for
 * whoever runs the installation, not for someone at the login screen.
 * Every session of that account is ended and the change is in the audit
 * trail. The planner logs in with the password alone and can set up
 * two-step verification again.
 *
 * Usage (in the web container, or next to the database):
 *   npx tsx scripts/reset-totp.ts <CODENAAM>
 *   docker compose exec web npx tsx scripts/reset-totp.ts <CODENAAM>
 */

import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

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

function main() {
  const [codenaam] = process.argv.slice(2);
  if (!codenaam) {
    console.error('Gebruik: npx tsx scripts/reset-totp.ts <CODENAAM>');
    process.exit(1);
  }

  const db = new Database(resolveDbPath());
  try {
    const person = db
      .prepare(`SELECT id, totp_secret FROM dienstrooster_person WHERE codenaam = ? AND rol IN ('ADMIN', 'PLANNER')`)
      .get(codenaam) as { id: string; totp_secret: string | null } | undefined;
    if (!person) {
      console.error(`${codenaam}: geen planner met deze codenaam.`);
      process.exit(1);
    }
    if (!person.totp_secret) {
      console.log(`${codenaam}: tweestapsverificatie stond al uit.`);
      return;
    }
    db.transaction(() => {
      db.prepare(
        'UPDATE dienstrooster_person SET totp_secret = NULL, sessie_versie = sessie_versie + 1 WHERE id = ?'
      ).run(person.id);
      db.prepare(
        `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, nieuw_json, tijdstip)
         VALUES (?, ?, 'person', ?, 'UPDATE', ?, ?)`
      ).run(
        crypto.randomUUID(),
        person.id,
        person.id,
        JSON.stringify({ wijziging: 'tweestapsverificatie uitgezet op de server', sessies_ingetrokken: true }),
        new Date().toISOString()
      );
    })();
    console.log(`${codenaam}: tweestapsverificatie staat uit. Inloggen gaat nu met alleen het wachtwoord.`);
  } finally {
    db.close();
  }
}

main();
