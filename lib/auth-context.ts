/**
 * Auth Context Helper
 *
 * Extracts the authenticated identity from the signed session cookie
 * (see lib/session.ts). There are two kinds of session:
 * - person: issued when a personal access link token is verified
 * - staff: issued when an ADMIN/PLANNER logs in with password(+TOTP)
 */

import { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/session';
import { db } from '@/db/client';

export interface AuthContext {
  userId: string;
  role: 'ADMIN' | 'PLANNER' | 'DEELNEMER';
  timestamp: string;
}

/**
 * Extract and verify the auth context from the request's session cookie.
 * Returns null if there is no session, or it's missing/tampered/expired.
 */
export function getAuthContextFromRequest(request: NextRequest): AuthContext | null {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) return null;

  if (session.kind === 'staff') {
    // A staff session cookie is self-contained and good for up to 12
    // hours - without re-checking here, deactivating an ADMIN/PLANNER
    // account would only block a *future* login, while a session issued
    // just before deactivation kept full access until it naturally
    // expired. Mirrors the same re-check already done below for a
    // person session's revoked-link case.
    //
    // Reads the live role too, not just whether the account is still
    // active: there's no role-mutation endpoint today, so session.role and
    // the database can't actually drift yet, but returning the live value
    // here (the same query, no extra cost) means that stays true even
    // after one is added, instead of a role downgrade only taking effect
    // once the 12-hour cookie naturally expires.
    const current = db
      .prepare(`SELECT rol FROM dienstrooster_person WHERE id = ? AND actief = 1`)
      .get(session.personId) as { rol: 'ADMIN' | 'PLANNER' | 'DEELNEMER' } | undefined;
    if (!current) return null;

    return {
      userId: session.personId,
      role: current.rol as 'ADMIN' | 'PLANNER',
      timestamp: new Date().toISOString(),
    };
  }

  // The session cookie is self-contained and good for up to 30 days, but a
  // personal link must be revocable "anytime" (CLAUDE.md) - without this
  // check, revoking someone's link (dienstrooster_person_access_link.
  // ingetrokken_op) would only stop a *future* login, while an already
  // logged-in session kept working until it naturally expired. Requires at
  // least one still-valid link for this person, not the specific one that
  // was used to log in - revoking access means losing it entirely, not
  // just that one link.
  //
  // Also rechecks actief, mirroring the staff-session recheck above -
  // there's no UI/route today that deactivates a DEELNEMER, so this can't
  // actually diverge from the link check yet, but it means a future one
  // doesn't silently leave an already-issued 30-day session valid.
  const stillValid = db
    .prepare(
      `SELECT 1 FROM dienstrooster_person_access_link pal
       JOIN dienstrooster_person p ON p.id = pal.person_id
       WHERE pal.person_id = ? AND pal.ingetrokken_op IS NULL AND p.actief = 1 LIMIT 1`
    )
    .get(session.personId);
  if (!stillValid) return null;

  return {
    userId: session.personId,
    role: 'DEELNEMER',
    timestamp: new Date().toISOString(),
  };
}

/**
 * True if the authenticated identity is an ADMIN or PLANNER.
 */
export function requirePlannerAccess(auth: AuthContext | null): boolean {
  if (!auth) return false;
  return auth.role === 'ADMIN' || auth.role === 'PLANNER';
}

/**
 * True if the authenticated identity is the given person, or staff acting on their behalf.
 */
export function requirePersonAccess(auth: AuthContext | null, personId: string): boolean {
  if (!auth) return false;
  if (auth.role === 'ADMIN' || auth.role === 'PLANNER') return true;
  return auth.userId === personId;
}
