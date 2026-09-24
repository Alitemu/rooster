/**
 * The TOTP secret of a staff account, stored encrypted the same way as the
 * mail app password (lib/settingsCrypto.ts): a copy of the database alone
 * no longer gives away the second factor of every planner.
 *
 * Secrets saved before this was encrypted are plain text; they still work
 * and are re-saved encrypted at the next successful login.
 *
 * If the key changes (a new SESSION_SECRET, or a lost .session_secret) the
 * secret can no longer be read and that planner cannot log in until
 * someone with access to the server runs scripts/reset-totp.ts.
 */

import { decryptSetting, encryptSetting } from './settingsCrypto';

export function encryptTotpSecret(secret: string): string {
  return encryptSetting(secret);
}

/** The secret, or null when it is stored encrypted but cannot be read. `legacy`: stored as plain text. */
export function readTotpSecret(stored: string): { secret: string | null; legacy: boolean } {
  if (stored.startsWith('v1:')) return { secret: decryptSetting(stored), legacy: false };
  return { secret: stored, legacy: true };
}
