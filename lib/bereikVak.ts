/**
 * Its own file, with no imports: components/StaffingOverview.tsx is a client component, and
 * lib/streefbereikPerPersoon.ts reaches the database through lib/rosterBands.ts (2.3.0: the build failed
 * on that, "Can't resolve 'fs'").
 */
/**
 * Where the dashed box over a bar in "Dienstdoende" stands, in diensten (2.3.0, the planner's choice of
 * three designs): on the range itself, half a dienst past each edge, so a count on the bottom or the top
 * ends inside it, one too many runs half a dienst past it and one too few stops half a dienst before it.
 * Never left of 0, the planner's rule: a bar starts there.
 */
export function bereikVak(bereik: { min: number; max: number } | null): { van: number; tot: number } | null {
  return bereik ? { van: Math.max(0, bereik.min - 0.5), tot: bereik.max + 0.5 } : null;
}
