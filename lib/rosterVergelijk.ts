/**
 * Which of two solver results is better, for the multi-attempt planners
 * (Herhaalplanner and Gerandomiseerde planner in
 * app/api/planner/period/[id]/generate-roster/route.ts), and when a result is
 * perfect. Moved out of the route so that the ranking has a test of its own.
 */

/**
 * Ranks two /solve outcomes against each other for the "Herhaalplanner" -
 * the same priority order the Prioriteitenplanner itself solves in
 * (dekking > eerlijkheid grootste afwijking > eerlijkheid totale afwijking
 * > liever-niet > voorkeur), so "beter" here means exactly what it means
 * inside a single solve, just applied across repeated ones. Returns true
 * when `a` is strictly better than `b`; a full tie keeps whichever was
 * found first (stable - doesn't churn the kept result for no reason).
 */
export function isBetterRoster(a: any, b: any): boolean {
  const tupleOf = (d: any) => [
    Array.isArray(d?.unfilled_slots) ? d.unfilled_slots.length : 0,
    d?.max_band_deviation ?? 0,
    d?.total_band_deviation ?? 0,
    d?.soft_block_violations ?? 0,
    -(d?.preference_matches ?? 0),
  ];
  const ta = tupleOf(a);
  const tb = tupleOf(b);
  for (let i = 0; i < ta.length; i++) {
    if (ta[i] !== tb[i]) return ta[i] < tb[i];
  }
  return false;
}

/**
 * "Perfect" per the planner's own stopping rule: every slot filled and
 * everyone exactly within their streefbereik (zero band slack either
 * direction). Window rule and ABSOLUUT blocks are hard constraints the
 * solver can never violate in any OPTIMAL/FEASIBLE result, so they need no
 * separate check here.
 */
export function isPerfectRoster(d: any): boolean {
  // A result that does not say which diensten are empty is not known to be perfect (it used to count as one).
  if (!Array.isArray(d?.unfilled_slots)) return false;
  return d.unfilled_slots.length === 0 && (d.max_band_deviation ?? 0) === 0;
}
