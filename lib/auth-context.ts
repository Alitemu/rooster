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
    return {
      userId: session.personId,
      role: session.role,
      timestamp: new Date().toISOString(),
    };
  }

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
