import { describe, it, expect } from 'vitest';
import { generateTOTPSecret, generateTOTPCode, verifyTOTPCode } from './auth';

/**
 * One rule = one test: a valid TOTP code must be accepted once, and a
 * replay of that same code (e.g. captured in transit) must be rejected -
 * proven by actually reusing a real generated code, not just asserted.
 */

describe('verifyTOTPCode replay protection', () => {
  it('accepts a fresh code once, then rejects the exact same code on reuse', () => {
    const { secret } = generateTOTPSecret('Test Persoon');
    const code = generateTOTPCode(secret);

    expect(verifyTOTPCode(secret, code)).toBe(true);
    expect(verifyTOTPCode(secret, code)).toBe(false);
  });

  it('does not let a replay on one secret block a fresh code on a different secret', () => {
    const secretA = generateTOTPSecret('Persoon A').secret;
    const secretB = generateTOTPSecret('Persoon B').secret;
    const codeA = generateTOTPCode(secretA);
    const codeB = generateTOTPCode(secretB);

    expect(verifyTOTPCode(secretA, codeA)).toBe(true);
    expect(verifyTOTPCode(secretB, codeB)).toBe(true);
  });

  it('rejects an invalid code', () => {
    const { secret } = generateTOTPSecret('Test Persoon 2');
    expect(verifyTOTPCode(secret, '000000')).toBe(false);
  });
});
