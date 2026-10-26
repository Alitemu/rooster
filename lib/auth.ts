/**
 * Authentication utilities
 *
 * Conventions:
 * - Passwords: bcrypt hashing (native bindings - see package.json; the
 *   $2a$/$2b$ hash format is identical to bcryptjs's, so switching here
 *   doesn't invalidate any password hash already stored in a database)
 * - Access tokens: SHA256 hash of long random token
 * - Always use ISO-8601 dates
 */

import crypto from 'crypto';
import bcrypt from 'bcrypt';

/**
 * Generate a long random token (for personal access links)
 * Returns the plaintext token - hash it before storing in DB
 */
export function generateAccessToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a token for storage in DB
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Hash a password using bcryptjs
 */
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * A fixed bcrypt hash that never matches any real password. A login route
 * that skips bcrypt.compare entirely when the account lookup itself
 * failed (unknown codenaam, deactivated account, no password set)
 * responds measurably faster than the real-password path - comparing
 * against this dummy hash in that case keeps the timing close to a real
 * attempt, closing the side-channel that would otherwise let a caller
 * distinguish "this codenaam exists" from "it doesn't" purely by
 * response time.
 */
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-timing-safety', 12);

/**
 * Constant-time comparison to prevent timing attacks
 */
export function secureCompare(a: string, b: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Check if a token is valid (hasn't been revoked)
 * Returns true if tokenRetractedOn is null
 */
export function isTokenValid(retractedOn: string | null): boolean {
  return retractedOn === null;
}

/**
 * Validate password strength
 * Returns empty array if valid, array of error messages if not
 */
export function validatePasswordStrength(password: string): string[] {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('Wachtwoord moet minimaal 8 tekens bevatten');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Wachtwoord moet kleine letters bevatten');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Wachtwoord moet hoofdletters bevatten');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Wachtwoord moet cijfers bevatten');
  }
  if (!/[!@#$%^&*()_\-+=\[\]{};:'",.<>?/\\|`~]/.test(password)) {
    errors.push('Wachtwoord moet speciale tekens bevatten');
  }

  return errors;
}
