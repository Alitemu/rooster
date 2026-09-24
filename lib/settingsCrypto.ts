/**
 * Encrypts a secret setting (the mail app password) for storage in the
 * database: AES-256-GCM with a key derived from the session secret
 * (lib/session.ts deriveSecretKey), which lives outside the database. A
 * copy of the database file alone does not give the password away.
 *
 * Format: "v1:" + base64url(iv | tag | ciphertext).
 */

import crypto from 'crypto';
import { deriveSecretKey } from './session';

const PURPOSE = 'app-settings';

export function encryptSetting(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveSecretKey(PURPOSE), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
}

/** null when it cannot be read: tampered with, or the session secret changed since. */
export function decryptSetting(stored: string): string | null {
  if (!stored.startsWith('v1:')) return null;
  try {
    const raw = Buffer.from(stored.slice(3), 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveSecretKey(PURPOSE), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
