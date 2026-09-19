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
