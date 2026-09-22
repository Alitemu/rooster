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

/**
 * Parse uploaded CSV text into rows of raw string cells (client-side, no
 * server round-trip - matches this app's other CSV imports, e.g.
 * import-balances/import-holidays, which parse in the browser and send
 * already-structured rows to the API rather than a raw file).
 *
 * A plain split(',') cuts a quoted field containing a comma (e.g. a
 * codenaam or note exported from Excel as `"foo, bar"`) into two cells,
 * silently misaligning every column after it. This handles the common
 * double-quote CSV convention (a "" inside a quoted field is a literal
 * quote) without pulling in a full CSV library for what's still a simple,
 * few-column import.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (inQuotes) {
        if (char === '"') {
          if (line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += char;
        }
      } else if (char === '"' && current === '') {
        // Only a quote at the very start of a cell opens quoted mode (RFC
        // 4180) - a stray `"` typed mid-field (e.g. `Persoon"05`) must stay
        // a literal character, not swallow the next comma as part of the
        // "quoted" text and silently merge two columns.
        inQuotes = true;
      } else if (char === ',') {
        cells.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    rows.push(cells);
  }
  return rows;
}
