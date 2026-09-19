/**
 * Validation for `person.codenaam`.
 *
 * The codenaam is the only identifier this application has for a person -
 * there are no names, e-mail addresses or phone numbers anywhere - so it
 * turns up in a lot of places that each have their own assumptions:
 *
 *   - the roster grid and the dashboard, which have to stay readable at
 *     375px (see CLAUDE.md's calendar constraints);
 *   - the CSV exports (lib/csv.ts guards formula injection there, but not
 *     length, and not a codenaam that is nothing but whitespace);
 *   - the Power Automate verzendlijst, which looks the codenaam up in an
 *     Excel sheet to find the matching mailbox - a codenaam with a stray
 *     newline in it silently fails to match there.
 *
 * Nothing enforced this, so a 300-character codenaam (or one consisting of
 * a single tab) was accepted and then broke those places one by one. The
 * check belongs at the boundary where a codenaam enters the system, not in
 * each consumer.
 */

/** Long enough for a real pseudonym, short enough for a mobile grid cell. */
export const CODENAAM_MAX_LENGTH = 40;

// Control characters (including newline and tab) plus the Unicode line and
// paragraph separators. These survive a `.trim()` in the middle of a
// string and corrupt CSV rows, HTTP headers and Excel lookups.
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u2028\u2029]/;

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
  if (typeof raw !== 'string') {
    return { valid: false, message: 'Codenaam is verplicht' };
  }

  const codenaam = raw.trim();

  if (codenaam.length === 0) {
    return { valid: false, message: 'Codenaam is verplicht' };
  }

  if (codenaam.length > CODENAAM_MAX_LENGTH) {
    return {
      valid: false,
      message: `Codenaam mag maximaal ${CODENAAM_MAX_LENGTH} tekens lang zijn`,
    };
  }

  if (CONTROL_CHARS.test(codenaam)) {
    return {
      valid: false,
      message: 'Codenaam mag geen regeleindes of andere onzichtbare tekens bevatten',
    };
  }

  return { valid: true, codenaam };
}
