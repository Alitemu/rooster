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

/**
 * The example under the calendar of how many colleagues are still free on a day (audit per role R-10,
 * 1.7.0). It said "15 van de 31" in every group, also in one of 30. Now half of the real group,
 * rounded down. Null while the group is not known yet: the legend then explains it without numbers.
 */
export function beschikbaarVoorbeeld(groep: number): { kort: string; tekst: string } | null {
  if (!Number.isInteger(groep) || groep < 1) return null;
  const vrij = Math.floor(groep / 2);
  return { kort: `${vrij}/${groep}`, tekst: `${vrij} van de ${groep}` };
}

/** How large the group is: the most people any day of the calendar counts (members can join halfway). */
export function groepsgrootte(dagen: Iterable<{ total_in_pool: number }>): number {
  let grootste = 0;
  for (const dag of dagen) if (dag.total_in_pool > grootste) grootste = dag.total_in_pool;
  return grootste;
}
