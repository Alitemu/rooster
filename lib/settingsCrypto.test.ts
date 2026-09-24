import { describe, it, expect } from 'vitest';
import { decryptSetting, encryptSetting } from './settingsCrypto';

/**
 * The mail app password is stored encrypted: it reads back only unchanged,
 * and anything tampered with - a changed byte, or the check shortened to
 * a few bytes that are far easier to guess - reads as "unreadable".
 */
describe('settingsCrypto', () => {
  it('reads back what it stored, never as plain text', () => {
    const stored = encryptSetting('abcdefghijklmnop');
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain('abcdefghijklmnop');
    expect(decryptSetting(stored)).toBe('abcdefghijklmnop');
  });

  it('refuses a changed ciphertext', () => {
    const raw = Buffer.from(encryptSetting('abcdefghijklmnop').slice(3), 'base64url');
    raw[raw.length - 1] ^= 1;
    expect(decryptSetting(`v1:${raw.toString('base64url')}`)).toBeNull();
  });

  it('refuses a shortened authentication tag', () => {
    // Empty text: iv (12) + tag (16) and no ciphertext, so cutting the end
    // off leaves a genuine 4-byte prefix of the real tag.
    const raw = Buffer.from(encryptSetting('').slice(3), 'base64url');
    expect(decryptSetting(`v1:${raw.subarray(0, 16).toString('base64url')}`)).toBeNull();
  });

  it('refuses anything without the version prefix', () => {
    expect(decryptSetting('abcdefghijklmnop')).toBeNull();
  });
});
