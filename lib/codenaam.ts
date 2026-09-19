/**
 * Validation for `person.codenaam`.
 *
 * The codenaam is the only identifier this application has for a person -
 * there are no names, e-mail addresses or phone numbers anywhere - so it
 * travels further than most fields. The rule itself lives in
 * lib/vrijeTekst.ts, which `schedule_period.naam` uses too; this module
 * only pins down what "short enough" means for a codenaam and keeps the
 * Dutch wording of its error messages.
 */

import { validateSingleLine } from './vrijeTekst';

/** Long enough for a real pseudonym, short enough for a mobile grid cell. */
export const CODENAAM_MAX_LENGTH = 40;

export type CodenaamValidation =
  | { valid: true; codenaam: string }
  | { valid: false; message: string };

/**
 * Normalise and validate a codenaam coming from user input.
 *
 * On success it returns the trimmed value to store - callers must use that
 * one rather than the raw input, so " Persoon-01 " and "Persoon-01" can
 * never end up as two different people with a UNIQUE constraint that sees
 * no conflict.
 */
export function validateCodenaam(raw: unknown): CodenaamValidation {
  const result = validateSingleLine(raw, 'Codenaam', CODENAAM_MAX_LENGTH);
  return result.valid ? { valid: true, codenaam: result.value } : result;
}
