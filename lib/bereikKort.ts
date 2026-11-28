/**
 * A range without the noun, the one way every planner's screen writes it (2.6.2): "2 of 3", "0 of 1", "2",
 * "2 tot en met 5". Never "2-3" or "2 tot 3" (CLAUDE.md). Its own file, with no imports but telwoord: the
 * generation dialog and the fellow notice are client components, and lib/streefbereikPerPersoon.ts reaches the
 * database through lib/rosterBands.ts. Until 2.6.2 there were three copies of it, and the fellow notice wrote
 * "4 tot 5 weekenddiensten" (the audit after 2.6.1).
 */
import { telwoord } from './telwoord';

export function bereikKort(min: number, max: number): string {
  if (min === max) return String(max);
  return max - min === 1 ? `${min} of ${max}` : `${min} tot en met ${max}`;
}

/** The others' weekend band in the fellow notice of "Rooster genereren": "4 of 5 weekenddiensten", "1 weekenddienst". */
export function weekendBereikTekst([min, max]: [number, number]): string {
  return min === max ? telwoord(min, 'weekenddienst', 'weekenddiensten') : `${bereikKort(min, max)} weekenddiensten`;
}
