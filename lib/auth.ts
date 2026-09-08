/**
 * Authentication utilities
 *
 * Conventions:
 * - Passwords: bcryptjs hashing
 * - TOTP: speakeasy library
 * - Access tokens: SHA256 hash of long random token
 * - Always use ISO-8601 dates
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';

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
 * Generate TOTP secret for 2FA setup
 * Returns secret and QR code data URL
 */
export function generateTOTPSecret(name: string, issuer: string = 'Dienstrooster') {
  const secret = speakeasy.generateSecret({
    name: `${issuer} (${name})`,
    issuer,
    length: 32,
  });

  return {
    secret: secret.base32,
    qrCode: secret.otpauth_url || '',
  };
}

// Per-secret last-accepted time-step, so a TOTP code (or one intercepted
// in transit) can't be replayed again within its own ±2-window validity
// - same threat model as a reused password, but a code is only 6 digits
// and the window deliberately tolerates clock drift, so without this a
// captured code stays usable for up to ~2.5 minutes. In-memory only:
// this app runs as a single process (see lib/rateLimit.ts for the same
// reasoning), and losing this on a restart just re-opens a ~2.5 minute
// window rather than anything worse.
const lastUsedTotpStep = new Map<string, number>();

/**
 * Verify a TOTP code, rejecting a code from a time-step already consumed
 * by an earlier successful verification for this secret.
 */
export function verifyTOTPCode(secret: string, code: string): boolean {
  const result = speakeasy.totp.verifyDelta({
    secret,
    encoding: 'base32',
    token: code,
    window: 2, // Allow ±2 time windows (30-second windows)
  });
  if (!result) return false;

  const currentStep = Math.floor(Date.now() / 1000 / 30);
  const usedStep = currentStep + result.delta;

  const lastUsed = lastUsedTotpStep.get(secret);
  if (lastUsed !== undefined && usedStep <= lastUsed) {
    return false;
  }

  lastUsedTotpStep.set(secret, usedStep);
  return true;
}

/**
 * Generate a 6-digit TOTP code from secret (for testing)
 */
export function generateTOTPCode(secret: string): string {
  return speakeasy.totp({
    secret,
    encoding: 'base32',
  });
}

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

  if (password.length < 12) {
    errors.push('Wachtwoord moet minimaal 12 tekens bevatten');
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

/**
 * Validate TOTP code format (6 digits)
 */
export function isValidTOTPFormat(code: string): boolean {
  return /^\d{6}$/.test(code);
}
