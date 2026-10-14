/**
 * A period's window settings, without the database: lib/rosterBands.ts
 * re-exports resolveWindowWeeks for the server, and the period page reads
 * vensterTekst from here in the browser.
 */

export interface WindowWeeksConfig {
  avond: number;
  weekendFeestdag: number;
}

/**
 * Resolve a period's window-rule settings, in the exact same shape
 * regardless of whether it was frozen before or after per-teller windows
 * existed - a period with only the old pooled `windowWeeks` gets that same
 * value for both groups (which, per requiredGapWeeks in lib/windowRule.ts,
 * reproduces the old pooled behaviour exactly: the cross-type floor and
 * each group's own cap both collapse to the same number).
 *
 * Shared by generate-roster/route.ts's solver request AND
 * lib/windowRule.ts's manual-assign/reassign conflict checks, so both
 * agree on what "the window" means for a given period - see
 * solver/constraints.py's add_window_constraints for the full
 * floor-plus-per-group reasoning this mirrors.
 */
export function resolveWindowWeeks(config: Record<string, unknown>): WindowWeeksConfig {
  const legacy = typeof config.windowWeeks === 'number' ? config.windowWeeks : 2;
  return {
    avond: typeof config.windowWeeksAvond === 'number' ? config.windowWeeksAvond : legacy,
    weekendFeestdag:
      typeof config.windowWeeksWeekendFeestdag === 'number' ? config.windowWeeksWeekendFeestdag : legacy,
  };
}

const weken = (n: number) => (n <= 0 ? 'uit' : n === 1 ? '1 week' : `${n} weken`);

/**
 * The window as the period header shows it: the windows the period
 * generates with. It showed the old single `windowWeeks`, which the
 * wizard sets to the avond window at opening and nothing changes after:
 * a weekend window of 4 never showed, and an avond window changed in the
 * generation dialog left the old number in the header (audit 14).
 */
export function vensterTekst(config: Record<string, unknown>): string {
  const { avond, weekendFeestdag } = resolveWindowWeeks(config);
  return avond === weekendFeestdag
    ? `Venster: ${weken(avond)}`
    : `Venster: avond ${weken(avond)} · weekend/feestdag ${weken(weekendFeestdag)}`;
}
