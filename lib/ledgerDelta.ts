/**
 * The bounds on one ledger entry, shared by the two routes that write them.
 *
 * A ledger delta is a number of shifts someone is owed or owes. Both
 * writing routes already required a whole number, but neither put a ceiling
 * on it, and both are fed by a spreadsheet: the beginsaldo import parses a
 * pasted CSV, and the saldo-correctie form takes a typed number. One column
 * off in that paste - an employee number, a year, a phone number - imports
 * as a perfectly valid delta.
 *
 * What makes that worth catching here is where it surfaces. Nothing shows a
 * raw ledger value to anyone (CLAUDE.md: never show the number, show the
 * words), so a delta of 123456 is invisible until lib/rosterBands.ts folds
 * it into someone's target range, and the planner sees a roster that cannot
 * be solved, or one person carrying every shift, with no hint of which of
 * the 31 rows caused it.
 *
 * The limit is deliberately far above any real value - a person can work at
 * most a few dozen shifts in a period, so a correction of even 50 is already
 * extraordinary - because its job is to catch a paste that is wrong by
 * orders of magnitude, not to second-guess a planner who means it.
 */

export const MAX_LEDGER_DELTA = 200;

export type DeltaValidation = { valid: true } | { valid: false; message: string };

/**
 * `label` names the row in user-facing Dutch (a codenaam, or a codenaam and
 * counter) so the message points at the one row that is wrong.
 */
export function validateLedgerDelta(delta: unknown, label: string): DeltaValidation {
  if (typeof delta !== 'number' || !Number.isInteger(delta)) {
    return { valid: false, message: `Ongeldig aantal voor ${label}: ${delta} is geen geheel getal` };
  }
  if (Math.abs(delta) > MAX_LEDGER_DELTA) {
    return {
      valid: false,
      message: `Ongeldig aantal voor ${label}: ${delta} ligt buiten -${MAX_LEDGER_DELTA} tot ${MAX_LEDGER_DELTA}. Klopt de kolom?`,
    };
  }
  return { valid: true };
}
