/**
 * Shared "may these two shifts still be swapped" check.
 *
 * A swap moves assignments between two participants without the planner
 * being involved, so it must only ever touch a roster that is already
 * final and still in the future:
 *
 * - GEPUBLICEERD only. On a CONCEPT/GESLOTEN/GEGENEREERD period the
 *   planner is still working on the roster, and an approved swap writes
 *   `bron = 'MANUAL'` on both assignments - which a regenerate then
 *   deliberately preserves (see lib/rosterGaps.ts's clearSolverAssignments).
 *   Two participants could therefore pin their own changes into a draft
 *   the planner hasn't published yet, and slot ids are known to anyone who
 *   fetched their own preferences.
 * - Future dates only. Swapping a shift that has already been worked
 *   rewrites history: the roster would no longer say who actually stood
 *   there, and the counters it feeds (saldo, carry-over) would silently
 *   move with it.
 */

export interface SwapEligibilityResult {
  allowed: boolean;
  code?: 'PERIOD_NOT_PUBLISHED' | 'SHIFT_IN_PAST';
  message?: string;
}

/** Local calendar date (YYYY-MM-DD) - slot dates are stored the same way. */
function todayISO(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function checkSwapAllowed(
  params: { periodStatus: string; slotDates: Array<string | null | undefined> },
  now: Date = new Date()
): SwapEligibilityResult {
  if (params.periodStatus !== 'GEPUBLICEERD') {
    return {
      allowed: false,
      code: 'PERIOD_NOT_PUBLISHED',
      message: 'Ruilen kan pas als het rooster gepubliceerd is',
    };
  }

  const today = todayISO(now);
  // A shift today is still swappable - it may not have started yet, and
  // the participants themselves are the ones agreeing to it.
  if (params.slotDates.some((datum) => !datum || datum < today)) {
    return {
      allowed: false,
      code: 'SHIFT_IN_PAST',
      message: 'Ruilen kan niet meer voor een dienst die al geweest is',
    };
  }

  return { allowed: true };
}
