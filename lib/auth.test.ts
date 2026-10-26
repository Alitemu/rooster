import { describe, it, expect } from 'vitest';
import { validatePasswordStrength } from './auth';

describe('validatePasswordStrength', () => {
  it('accepts 8 characters and refuses 7', () => {
    expect(validatePasswordStrength('Abcde1!x')).toEqual([]);
    expect(validatePasswordStrength('Abcd1!x')).toContain('Wachtwoord moet minimaal 8 tekens bevatten');
  });
});
