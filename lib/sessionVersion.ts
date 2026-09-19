/**
 * Session revocation.
 *
 * A session cookie here is a self-contained signed token (lib/session.ts):
 * nothing about it is stored server-side, which is what makes it cheap,
 * and also what made "log out" a browser-only gesture. Clearing the cookie
 * removes it from the browser that asked; a copy of the same cookie taken
 * anywhere else (a shared machine, a synced profile, a captured request)
 * kept working right up to its natural expiry - 12 hours for staff, 30
 * days for a participant.
 *
 * The fix is one integer per person, baked into every token issued for
 * them and compared on every request. Raising it leaves every token minted
 * before that moment failing the comparison, so revoking every session is
 * a single UPDATE. No session table, no per-request lookup beyond the row
 * lib/auth-context.ts already reads.
 */

import { db } from '@/db/client';

/**
 * The person's current session version, or null when there is no such
 * person (deleted between issuing the cookie and using it).
 */
export function getSessionVersion(personId: string): number | null {
  const row = db
    .prepare('SELECT sessie_versie FROM dienstrooster_person WHERE id = ?')
    .get(personId) as { sessie_versie: number } | undefined;
  return row ? row.sessie_versie : null;
}

/**
 * Invalidate every session currently issued for this person, including the
 * one making the request. Callers that want to keep the current browser
 * signed in issue a fresh cookie afterwards with the new version.
 *
 * Returns the new version.
 */
export function revokeAllSessions(personId: string): number {
  const row = db
    .prepare(
      `UPDATE dienstrooster_person SET sessie_versie = sessie_versie + 1
       WHERE id = ?
       RETURNING sessie_versie`
    )
    .get(personId) as { sessie_versie: number } | undefined;

  if (!row) {
    throw new Error(`Cannot revoke sessions for unknown person ${personId}`);
  }
  return row.sessie_versie;
}
