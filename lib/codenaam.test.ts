import { describe, it, expect } from 'vitest';
import { validateCodenaam, CODENAAM_MAX_LENGTH } from './codenaam';

/**
 * The hard rule: a codenaam that reaches the database is always a trimmed,
 * non-empty, single-line string of at most CODENAAM_MAX_LENGTH characters.
 *
 * Each test below fails if that can be violated, rather than demonstrating
 * one well-formed example.
 */

describe('validateCodenaam', () => {
  it('accepts an ordinary codenaam unchanged', () => {
    const result = validateCodenaam('Persoon-01');
    expect(result).toEqual({ valid: true, codenaam: 'Persoon-01' });
  });

  it('returns the trimmed value, so padding cannot create a duplicate person', () => {
    // The UNIQUE constraint on codenaam compares exactly: " Persoon-01 "
    // and "Persoon-01" would be two rows for one person if the untrimmed
    // input were stored.
    const padded = validateCodenaam('  Persoon-01  ');
    const bare = validateCodenaam('Persoon-01');
    expect(padded.valid && bare.valid).toBe(true);
    expect(padded.valid ? padded.codenaam : null).toBe(bare.valid ? bare.codenaam : undefined);
  });

  it('rejects anything that is only whitespace', () => {
    for (const input of ['', '   ', '\t', '\n', ' \t\n ']) {
      expect(validateCodenaam(input).valid, JSON.stringify(input)).toBe(false);
    }
  });

  it('rejects a non-string, so a JSON body of the wrong shape cannot slip through', () => {
    for (const input of [null, undefined, 42, {}, ['Persoon-01']]) {
      expect(validateCodenaam(input).valid, JSON.stringify(input)).toBe(false);
    }
  });

  it('accepts exactly the maximum length and rejects one character more', () => {
    const atLimit = 'P'.repeat(CODENAAM_MAX_LENGTH);
    const overLimit = 'P'.repeat(CODENAAM_MAX_LENGTH + 1);
    expect(validateCodenaam(atLimit).valid).toBe(true);
    expect(validateCodenaam(overLimit).valid).toBe(false);
  });

  it('measures the length after trimming, not before', () => {
    const atLimit = `  ${'P'.repeat(CODENAAM_MAX_LENGTH)}  `;
    expect(validateCodenaam(atLimit).valid).toBe(true);
  });

  it('rejects control characters anywhere in the value', () => {
    // A trailing newline is caught by the trim; one in the middle is not,
    // and that is the one that breaks CSV rows and the Excel lookup in the
    // verzendlijst.
    for (const input of ['Persoon\n01', 'Persoon\t01', 'Persoon\r01', 'Persoon\u000001', 'Persoon\u202801']) {
      expect(validateCodenaam(input).valid, JSON.stringify(input)).toBe(false);
    }
  });

  it('still allows the punctuation real pseudonyms use', () => {
    for (const input of ['Persoon-01', 'AIOS 3', "O'Hara-01", 'Arts_A', 'Persoon (nacht)']) {
      expect(validateCodenaam(input).valid, input).toBe(true);
    }
  });
});
