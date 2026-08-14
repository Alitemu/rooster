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

/**
 * Verify a TOTP code
 */
export function verifyTOTPCode(secret: string, code: string): boolean {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token: code,
    window: 2, // Allow ±2 time windows (30-second windows)
  });
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
    errors.push('Password must be at least 12 characters');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain lowercase letters');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain uppercase letters');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain numbers');
  }
  if (!/[!@#$%^&*()_\-+=\[\]{};:'",.<>?/\\|`~]/.test(password)) {
    errors.push('Password must contain special characters');
  }

  return errors;
}

/**
 * Validate TOTP code format (6 digits)
 */
export function isValidTOTPFormat(code: string): boolean {
  return /^\d{6}$/.test(code);
}
