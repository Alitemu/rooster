/**
 * What "Geldig vanaf" and "Geldig tot" start at when the planner adds
 * someone on "Personeel beheren".
 *
 * Geldig vanaf: the start of the pool's one period still being rostered -
 * OPEN, GESLOTEN or GEGENEREERD, not yet published - so they count for all
 * of it; anything less clear-cut (none, or two at once) gives today. CONCEPT
 * is left out: its dates are rounded to whole ISO weeks only when it opens.
 *
 * Geldig tot: OPEN_EINDE, an open end, whatever the period (0.901.0). It
 * used to be the period's own end: an AIOS quarter, so every AIOS added had
 * to be extended by hand every quarter, 30 of them, while most stay for
 * years. Someone who leaves earlier gets an end date then. Without a
 * period it was 2029-12-31, which would have dropped everyone added that
 * way out of the pool at once, at the end of 2029, with nothing to say why.
 * Before 0.805.0 it was empty, and a planner who then typed an end date
 * short of the period had people who counted for nothing after it.
 *
 * Pure, no db: used by the client page and tested on its own.
 */

/** The same open end a clean start gives its participants (scripts/seed.ts addBareStartParticipants). */
export const OPEN_EINDE = '2099-12-31';

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
  /** The period Geldig vanaf came from, or null for today. */
  periode: string | null;
}

export function newMembershipDefaults(periods: PeriodForDefaults[], poolId: string, today: string): MembershipDefaults {
  const current = periods.filter((p) => p.pool_id === poolId && BEING_ROSTERED.has(p.status));
  if (current.length === 1) {
    return { geldig_vanaf: current[0].start_datum, geldig_tot: OPEN_EINDE, periode: current[0].naam };
  }
  return { geldig_vanaf: today, geldig_tot: OPEN_EINDE, periode: null };
}
