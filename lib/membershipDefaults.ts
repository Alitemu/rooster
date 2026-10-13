/**
 * What "Geldig vanaf" and "Geldig tot" start at when the planner adds
 * someone on "Personeel beheren".
 *
 * They used to start at today and empty. A planner who then typed an end
 * date that stopped short of the period being rostered had people who
 * counted for nothing after it: 160 empty shifts with every planner and
 * every window, and no way to see why on screen.
 *
 * The pool's one period still being rostered - OPEN, GESLOTEN or
 * GEGENEREERD, not yet published - gives its own dates, like the setup
 * wizard's "Personeel" step already did. Anything less clear-cut (none, or
 * two at once) gives today until FALLBACK_GELDIG_TOT. CONCEPT is left out:
 * its dates are rounded to whole ISO weeks only when it opens.
 *
 * Pure, no db: used by the client page and tested on its own.
 */

export const FALLBACK_GELDIG_TOT = '2029-12-31';

const BEING_ROSTERED = new Set(['OPEN', 'GESLOTEN', 'GEGENEREERD']);

export interface PeriodForDefaults {
  naam: string;
  pool_id: string;
  status: string;
  start_datum: string;
  eind_datum: string;
}

export interface MembershipDefaults {
  geldig_vanaf: string;
  geldig_tot: string;
  /** The period the dates came from, or null for today until FALLBACK_GELDIG_TOT. */
  periode: string | null;
}

export function newMembershipDefaults(periods: PeriodForDefaults[], poolId: string, today: string): MembershipDefaults {
  const current = periods.filter((p) => p.pool_id === poolId && BEING_ROSTERED.has(p.status));
  if (current.length === 1) {
    return { geldig_vanaf: current[0].start_datum, geldig_tot: current[0].eind_datum, periode: current[0].naam };
  }
  return { geldig_vanaf: today, geldig_tot: FALLBACK_GELDIG_TOT, periode: null };
}
