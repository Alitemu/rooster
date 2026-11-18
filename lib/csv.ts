/**
 * CSV for the files the app writes for itself (the preferences backups,
 * lib/preferencesBackup.ts) and reads from a planner's upload (beginsaldi,
 * "Eerdere toewijzingen").
 *
 * The downloads are workbooks now (lib/xlsxWrite.ts); the formula guard
 * below stays for the backups, which are written to be opened in a
 * spreadsheet, and withoutFormulaGuard for a CSV download from before.
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
 * A cell as this app wrote it, read back: the apostrophe csvField put in
 * front of =, +, - or @ comes back from Excel with the value. For
 * matching a codenaam a re-imported file names.
 */
export function withoutFormulaGuard(value: string): string {
  // \x27 is the apostrophe: a bare one here reads as the start of a string
  // to app/dutchStyle.test.ts, which then runs on into the comments.
  return /^\x27[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
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
 * Parse uploaded CSV text into rows of raw string cells (client-side, no
 * server round-trip - matches this app's other CSV imports, e.g.
 * import-balances/import-holidays, which parse in the browser and send
 * already-structured rows to the API rather than a raw file).
 *
 * A plain split(',') cuts a quoted field containing a comma (e.g. a
 * codenaam or note exported from Excel as `"foo, bar"`) into two cells,
 * silently misaligning every column after it. This handles the common
 * double-quote CSV convention (a "" inside a quoted field is a literal
 * quote) without pulling in a full CSV library for what is still a simple,
 * few-column import.
 *
 * Commas or semicolons, whichever the first line uses more of outside
 * quotes: a Dutch Excel saves "CSV" with semicolons (the list separator of
 * Dutch regional settings), and the beginsaldi and "Eerdere toewijzingen"
 * imports turned every such line into one cell: every codenaam unknown,
 * the beginsaldi only noticed once the period had opened (audit 12). A
 * byte order mark ("CSV UTF-8") is dropped.
 */
export function parseCsv(text: string): string[][] {
  const lines = logicalLines(text.replace(/^\uFEFF/, '')).map((l) => l.trim()).filter((l) => l !== '');
  const delimiter = lines.length > 0 && countOutsideQuotes(lines[0], ';') > countOutsideQuotes(lines[0], ',') ? ';' : ',';
  const rows: string[][] = [];
  for (const line of lines) {
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
        // a literal character, not swallow the next delimiter as part of
        // the "quoted" text and silently merge two columns.
        inQuotes = true;
      } else if (char === delimiter) {
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

/**
 * The text split into lines, but not at a line break inside a quoted cell: a
 * cell that holds a line break (Excel saves it so) is one cell, not two rows.
 * A quote opens a cell the same way parseCsv's cells do: at the start of one.
 */
function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      current += char;
      if (char === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      }
    } else if (char === '"' && (current === '' || current.endsWith(',') || current.endsWith(';'))) {
      inQuotes = true;
      current += char;
    } else if (char === '\n') {
      lines.push(current.replace(/\r$/, ''));
      current = '';
    } else {
      current += char;
    }
  }
  lines.push(current.replace(/\r$/, ''));
  return lines;
}

function countOutsideQuotes(line: string, char: string): number {
  let count = 0;
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (c === char && !inQuotes) count++;
  }
  return count;
}
