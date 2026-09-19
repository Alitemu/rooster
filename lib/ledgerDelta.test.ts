import { describe, it, expect } from 'vitest';
import { validateLedgerDelta, MAX_LEDGER_DELTA } from './ledgerDelta';

/**
 * The hard rule: a ledger delta is a whole number of shifts, within a range
 * a real person could plausibly owe or be owed.
 *
 * Both writing routes are fed from a spreadsheet, so the mistake worth
 * catching is a pasted column that is not the saldo column - an employee
 * number or a year imports as a perfectly valid integer, and only surfaces
 * much later as a roster that cannot be solved.
 */

describe('validateLedgerDelta', () => {
  it('accepts the everyday values', () => {
    for (const delta of [-3, -1, 0, 1, 2, 8]) {
      expect(validateLedgerDelta(delta, 'Persoon-01').valid).toBe(true);
    }
  });

  it('accepts exactly the limit at both ends', () => {
    expect(validateLedgerDelta(MAX_LEDGER_DELTA, 'Persoon-01').valid).toBe(true);
    expect(validateLedgerDelta(-MAX_LEDGER_DELTA, 'Persoon-01').valid).toBe(true);
  });

  it('refuses one past the limit at both ends', () => {
    expect(validateLedgerDelta(MAX_LEDGER_DELTA + 1, 'Persoon-01').valid).toBe(false);
    expect(validateLedgerDelta(-MAX_LEDGER_DELTA - 1, 'Persoon-01').valid).toBe(false);
  });

  it('refuses the shapes a wrong spreadsheet column actually produces', () => {
    // An employee number, a year, a phone number, a postcode as a number.
    for (const delta of [123456, 2027, 612345678, 1011]) {
      expect(validateLedgerDelta(delta, 'Persoon-01').valid).toBe(false);
    }
  });

  it('refuses anything that is not a whole number', () => {
    for (const delta of [1.5, NaN, Infinity, -Infinity, '3', null, undefined, {}]) {
      expect(validateLedgerDelta(delta, 'Persoon-01').valid).toBe(false);
    }
  });

  it('names the row in the message, so a planner knows which one to fix', () => {
    const result = validateLedgerDelta(99999, 'Persoon-07 (AVOND)');
    expect(result.valid).toBe(false);
    expect((result as { message: string }).message).toContain('Persoon-07 (AVOND)');
  });
});
