/**
 * ISO-8601 date-only validation.
 *
 * Dates are stored and compared as `YYYY-MM-DD` strings throughout this
 * application (see CLAUDE.md) - that works because that format sorts
 * chronologically as text, which is exactly what membership ranges, period
 * bounds and slot lookups rely on. It only holds for strings that really
 * are in that format, so it has to be checked where one enters the system.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when `value` is a real calendar date in `YYYY-MM-DD` form.
 *
 * The round-trip through Date catches the dates that match the pattern but
 * do not exist ("2027-02-30", "2027-13-01"): JavaScript rolls those over to
 * the following month rather than rejecting them, so the only reliable test
 * is whether formatting the parsed value gives back what came in.
 */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  // Parsed as UTC (date-only strings always are), and read back in UTC, so
  // the container's timezone can never shift the result across a day.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * A real date within the years a roster can concern (2000 to 2199). The part-time overlap check walks the days of a
 * pattern, so "from 1000-01-01 to 9999-12-31" held the whole app for seconds on every request.
 */
export function isPlausibleIsoDate(value: unknown): value is string {
  return isValidIsoDate(value) && value >= '2000-01-01' && value <= '2199-12-31';
}

/**
 * A date as a planner's file may hold it: YYYY-MM-DD, or d-m-yyyy (also
 * with / or .) the way a Dutch Excel writes a date back when it saves a
 * CSV it opened. The real calendar date as YYYY-MM-DD, or null.
 */
export function parseDutchOrIsoDate(value: string): string | null {
  const text = value.trim();
  if (isValidIsoDate(text)) return text;
  const nl = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (!nl) return null;
  const [, d, m, y] = nl;
  const datum = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isValidIsoDate(datum) ? datum : null;
}

/** Excel's day number (1 = 1900-01-01, with its 1900 leap-day quirk) as YYYY-MM-DD. */
export function excelSerialToDate(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A date cell of a planner's upload: Excel's day number when it came from
 * a workbook (lib/xlsx.ts gives a date cell's number, the downloads write
 * real dates), otherwise as parseDutchOrIsoDate reads text. YYYY-MM-DD or
 * null.
 */
export function parseSheetDate(value: string): string | null {
  if (/^\d{5}(\.0+)?$/.test(value.trim())) return excelSerialToDate(Number(value));
  return parseDutchOrIsoDate(value);
}

/**
 * The longest a period may be, in days: two years, and some room for
 * rounding to whole ISO weeks. There was no limit at all, and every day
 * of a period becomes a slot - a year typed as 2207 instead of 2027 made
 * a period of 180 years (66,000 slots when it opened), and the wizard's
 * live capacity check worked through every day of whatever the address
 * held, on the one thread that serves everyone (audit 11).
 */
export const MAX_PERIODE_DAGEN = 750;

/**
 * Why `start`..`eind` (both valid YYYY-MM-DD) can't be a period, or null:
 * start not before the end, or longer than MAX_PERIODE_DAGEN.
 */
export function periodRangeProblem(start: string, eind: string): string | null {
  const days = (Date.parse(`${eind}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
  if (days <= 0) return 'Startdatum moet vóór einddatum liggen';
  if (days > MAX_PERIODE_DAGEN) return 'Een periode mag hoogstens twee jaar duren. Kijk het jaartal na.';
  return null;
}
