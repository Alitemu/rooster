/**
 * The letters in the preferences calendar of the achterwacht and the
 * legend above it, from one place: every letter a cell shows is explained
 * (the legend once named A and W but not F, while the cells showed all three).
 */

const DIENST_NAAM: Record<string, string> = {
  AVOND: 'Avonddienst',
  WEEKEND: 'Weekenddienst',
  FEESTDAG: 'Feestdagdienst',
};

/** The letter a cell shows for a counter: A, W, F. */
export function dienstLetter(counter: string): string {
  return counter[0];
}

/** One legend entry per counter the calendar shows, in that order. */
export function dienstLegenda(counters: string[]): Array<{ counter: string; letter: string; naam: string }> {
  return counters.map((counter) => ({ counter, letter: dienstLetter(counter), naam: DIENST_NAAM[counter] ?? counter }));
}
