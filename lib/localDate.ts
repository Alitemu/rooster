/**
 * Today's date as YYYY-MM-DD in the Netherlands.
 *
 * `new Date().toISOString().slice(0, 10)` is today in UTC: from midnight
 * until one (winter) or two (summer) o'clock Dutch time that is still
 * yesterday, so "Personeel beheren" showed someone starting today as
 * "Begint later" and gave a new member yesterday's date (audit 9). The
 * zone is named rather than taken from the machine: the browser of a
 * planner abroad and a server without TZ set should still agree with the
 * ward's calendar.
 *
 * Pure, no db: used by routes and client pages alike.
 */

export const APP_TIME_ZONE = 'Europe/Amsterdam';

/** The calendar date of `at` in the Netherlands, YYYY-MM-DD. */
export function localIsoDate(at: Date = new Date()): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** The date and time of `at` on the ward's clock, YYYY-MM-DDTHH:MM, as a deadline is written and stored. */
export function localIsoMinute(at: Date = new Date()): string {
  const delen = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: APP_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  return `${delen.year}-${delen.month}-${delen.day}T${delen.hour}:${delen.minute}`;
}
