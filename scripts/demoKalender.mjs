/**
 * The calendar the seed and the browser checks work in.
 *
 * The seeded period, the e2e fixtures and the checks were written against
 * Monday 4 January 2027. A period in the past answers "alleen nog bekijken",
 * a deadline in the past is refused and a shift in the past cannot be swapped,
 * so from the end of 2026 every one of those checks would have failed on the
 * calendar alone.
 *
 * `verschuifDagen()` is how far everything moves: nothing while the base
 * period still starts at least six weeks from now, otherwise a whole number
 * of weeks (the weekday never changes) that puts it six weeks ahead again.
 * DEMO_SHIFT_WEEKS forces a number of weeks, to run the checks on a shifted
 * calendar before the real date makes it necessary.
 *
 * Plain JavaScript so that the .mjs checks and the TypeScript seed and e2e
 * fixtures share one implementation.
 */

export const BASIS_START = '2027-01-04'; // Monday of ISO week 1 of 2027
const DAG_MS = 86_400_000;
const VOORUIT_DAGEN = 42;

/** @param {string} iso YYYY-MM-DD @returns {number} */
function utcMs(iso) {
  const [j, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(j, m - 1, d);
}

/** @param {Date} [nu] @returns {number} days to add to every base date */
export function verschuifDagen(nu = new Date()) {
  const gedwongen = process.env.DEMO_SHIFT_WEEKS;
  if (gedwongen !== undefined && gedwongen !== '') {
    const weken = Number(gedwongen);
    if (!Number.isInteger(weken) || weken < 0) throw new Error('DEMO_SHIFT_WEEKS moet een geheel getal van 0 of meer zijn');
    return weken * 7;
  }
  const vandaag = Date.UTC(nu.getFullYear(), nu.getMonth(), nu.getDate());
  const grens = vandaag + VOORUIT_DAGEN * DAG_MS;
  const basis = utcMs(BASIS_START);
  if (grens <= basis) return 0;
  return 7 * Math.ceil((grens - basis) / (7 * DAG_MS));
}

/**
 * A base date or date-time moved by `dagen`; the time of day and any zone
 * suffix stay as they were.
 * @param {string} tekst YYYY-MM-DD, optionally followed by T and a time
 * @param {number} dagen
 * @returns {string}
 */
export function verschuif(tekst, dagen) {
  if (dagen === 0) return tekst;
  const nieuw = new Date(utcMs(tekst) + dagen * DAG_MS).toISOString().slice(0, 10);
  return nieuw + tekst.slice(10);
}
