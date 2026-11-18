/**
 * The window between two shifts of one person, without the database: lib/windowRule.ts uses these
 * for its warnings, and the browser for checking the picks of one round in Rooster vooraf invullen
 * against each other (lib/vooraf.ts, audit 1.2.2). Moved here from lib/windowRule.ts in 1.3.0, which
 * re-exports them.
 */
import type { WindowWeeksConfig } from './rosterBands';

/** Days between two YYYY-MM-DD dates, whichever comes first. */
export function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Whether two shifts sit closer than a window of `weeks` allows: fewer than 7 * weeks days apart. */
export function tooClose(a: string, b: string, weeks: number): boolean {
  return weeks > 0 && daysApart(a, b) < 7 * weeks;
}

const windowGroup = (teller: string): 'avond' | 'weekend_feestdag' =>
  teller === 'AVOND' ? 'avond' : 'weekend_feestdag';

/**
 * The minimum gap (in weeks) required between a shift of `tellerA` and one
 * of `tellerB` for the same person, under per-teller windows - same
 * teller (both AVOND, or both WEEKEND/FEESTDAG): that group's own window;
 * different tellers: the smaller of the two windows (the cross-type
 * floor). A period with only the legacy pooled windowWeeks resolves to
 * `windows.avond === windows.weekendFeestdag` (see
 * lib/rosterBands.ts's resolveWindowWeeks), which collapses this to that
 * one shared value regardless of teller - reproducing the old pooled
 * behaviour exactly, not a special case to branch on separately.
 */
export function requiredGapWeeks(tellerA: string, tellerB: string, windows: WindowWeeksConfig): number {
  if (windowGroup(tellerA) === windowGroup(tellerB)) {
    return tellerA === 'AVOND' ? windows.avond : windows.weekendFeestdag;
  }
  return Math.min(windows.avond, windows.weekendFeestdag);
}
