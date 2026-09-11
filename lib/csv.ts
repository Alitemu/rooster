/**
 * Shared CSV field/filename helpers for the planner's exports
 * (invitations, audit-trail, status-report).
 *
 * Was duplicated near-identically in all three routes; kept in one place
 * now so a fix like the formula-injection guard below only has to happen
 * once.
 */

// Leading =, +, -, @ (also tab/CR, which some spreadsheet apps treat the
// same way) make a cell a formula when the file is opened in Excel/Numbers/
// Sheets - "CSV injection". Every field here is either planner-entered
// free text (codenaam, reden) or content this app generated itself, so an
// attacker only needs one of those free-text fields to plant something
// like `=HYPERLINK(...)` for it to execute in whoever opens the export.
// Prefixing a bare apostrophe is the standard mitigation: spreadsheet apps
// render it as plain text starting with the original character, not as a
// formula, and it's invisible in the actual cell content.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function guardFormulaInjection(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/**
 * Quote and escape one CSV field, per RFC 4180 (double any embedded `"`),
 * and guard against formula injection (see above). `null`/`undefined`
 * become an empty field.
 */
export function csvField(value: string | number | null | undefined): string {
  const str = guardFormulaInjection(String(value ?? ''));
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Sanitize free text (e.g. a period's planner-entered naam) for use inside
 * a quoted Content-Disposition filename - a `"` would break out of the
 * quoted string and a CR/LF could corrupt the response header.
 */
export function sanitizeFilenamePart(value: string): string {
  return value.replace(/[\r\n"\\]/g, '_');
}
