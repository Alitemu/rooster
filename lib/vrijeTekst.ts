/**
 * The one rule for short free text a planner or participant types in.
 *
 * Two fields live under it - `person.codenaam` and
 * `schedule_period.naam` - and both travel a lot further than the screen
 * they were typed on:
 *
 *   - the roster grid and the dashboard, which have to stay readable at
 *     375px (see CLAUDE.md's calendar constraints);
 *   - the CSV exports (lib/csv.ts guards formula injection there, but not
 *     length, and not a value that is nothing but whitespace);
 *   - the download filename, via sanitizeFilenamePart;
 *   - the e-mail subject and body the verzendlijst hands to Power
 *     Automate, where a stray newline splits a subject line in two and a
 *     codenaam that does not match its row in the Excel sheet silently
 *     finds no mailbox.
 *
 * None of those consumers can sensibly repair a bad value, and each would
 * fail differently. So it is checked once, here, at the boundary where the
 * value enters the system.
 */

// Control characters (including newline and tab) plus the Unicode line and
// paragraph separators. These survive a `.trim()` in the middle of a
// string and are what corrupt CSV rows, header lines and Excel lookups.
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u2028\u2029]/;

export type TextValidation =
  | { valid: true; value: string }
  | { valid: false; message: string };

/**
 * Normalise and validate one line of free text.
 *
 * On success it returns the trimmed value to store - callers must use that
 * one rather than the raw input, so " Persoon-01 " and "Persoon-01" can
 * never end up as two rows that a UNIQUE constraint sees no conflict
 * between.
 *
 * `label` is user-facing Dutch and appears in the error message.
 */
export function validateSingleLine(raw: unknown, label: string, maxLength: number): TextValidation {
  if (typeof raw !== 'string') {
    return { valid: false, message: `${label} is verplicht` };
  }

  const value = raw.trim();

  if (value.length === 0) {
    return { valid: false, message: `${label} is verplicht` };
  }

  // Measured after trimming, so padding never counts against the limit.
  if (value.length > maxLength) {
    return { valid: false, message: `${label} mag maximaal ${maxLength} tekens lang zijn` };
  }

  if (CONTROL_CHARS.test(value)) {
    return {
      valid: false,
      message: `${label} mag geen regeleindes of andere onzichtbare tekens bevatten`,
    };
  }

  return { valid: true, value };
}
