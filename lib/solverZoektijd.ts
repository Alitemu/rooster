/**
 * How long the achterwacht's solver searches, and the words of "Rooster genereren"
 * (components/RosterGenerationDialog.tsx) about it.
 *
 * 2.6.0: the planner chooses before generating, as for the AIOS
 * (components/AiosRoosterMaken.tsx): 10, 15 or 30 minutes, or a whole number of
 * minutes of their own from 1 to 60 (solver/main.py takes up to 3600 seconds
 * since 2.6.0, the planner's choice). 10 minutes is the default. Until 2.6.0 a
 * first run searched 5 minutes (0.905.0; 2 minutes before that) and only the
 * button after a result offered more.
 *
 * After a result the solver could not prove best (FEASIBLE), the dialog still
 * offers more: 10 minutes, then 30, then 60. That is a new run from the start,
 * not more time on top of the last one: it does not go on from the roster on
 * screen, and its roster replaces that one even when it is not better
 * (generate-roster/route.ts clearSolverAssignments). Diensten filled in by hand
 * stay. Until 0.904.0 the button said "5 minuten langer proberen", which read
 * as 2 + 5 minutes going on from where it stopped.
 */

/** The search time chosen unless the planner picks another, and what generate-roster/route.ts sends when none comes. */
export const STANDAARD_ZOEKTIJD_SECONDEN = 600;
/** The longest search on offer, and what the route and solver/main.py take. */
export const MAX_ZOEKTIJD_SECONDEN = 3600;
/** The choices in the dialog, besides "Zelf kiezen" (the AIOS's: lib/aiosGenereren.ts AIOS_TIJDSLIMIETEN). */
export const ZOEKTIJD_KEUZES = [600, 900, 1800] as const;
/** "Zelf kiezen": a whole number of minutes from 1 up to this. */
export const MAX_ZOEKTIJD_MINUTEN = MAX_ZOEKTIJD_SECONDEN / 60;
/** The value of "Zelf kiezen" in the dialog's list. */
export const EIGEN_ZOEKTIJD = 'eigen';

/**
 * The search time the dialog's choice stands for, in seconds, or null while "Zelf kiezen" holds no whole number of
 * minutes from 1 to 60 (then "Genereren" waits).
 */
export function gekozenZoektijd(keuze: string, eigenMinuten: string): number | null {
  if (keuze === EIGEN_ZOEKTIJD) {
    if (!/^\d+$/.test(eigenMinuten.trim())) return null;
    const minuten = Number(eigenMinuten.trim());
    return minuten >= 1 && minuten <= MAX_ZOEKTIJD_MINUTEN ? minuten * 60 : null;
  }
  const seconden = Number(keuze);
  return (ZOEKTIJD_KEUZES as readonly number[]).includes(seconden) ? seconden : null;
}

export function zoektijdWoorden(seconden: number): string {
  if (seconden < 60) return `${seconden} seconden`;
  const minuten = Math.round(seconden / 60);
  return `${minuten} ${minuten === 1 ? 'minuut' : 'minuten'}`;
}

/** The next search time offered after a FEASIBLE result: the next of 10, 30 and 60 minutes above the last, then none. */
export function volgendeZoektijd(vorige: number | null): number | null {
  const was = vorige ?? STANDAARD_ZOEKTIJD_SECONDEN;
  return [600, 1800, MAX_ZOEKTIJD_SECONDEN].find((stap) => stap > was) ?? null;
}

/**
 * What the route sends the solver: the planner's choice, else the default 10 minutes for the two ways that run
 * CP-SAT once. Herhaalplanner (multi_start) repeats a solve up to 100 times and keeps the solver's own default per
 * attempt; Willekeurig (randomized) does not search at all.
 */
export function zoektijdVoorGeneratie(gevraagd: number | undefined, modus: string): number | undefined {
  if (gevraagd !== undefined) return gevraagd;
  return modus === 'weighted' || modus === 'lexicographic' ? STANDAARD_ZOEKTIJD_SECONDEN : undefined;
}

/** The button that makes the roster again with more search time. */
export function opnieuwKnopTekst(volgende: number): string {
  return `Opnieuw maken met ${zoektijdWoorden(volgende)} zoektijd`;
}

/**
 * Above that button: why, and that it starts over. "Kon met een zoektijd van": the search can stop
 * well before that time (each phase in solver/solver.py gets a share of it), so "had na 5 minuten" read
 * wrong next to "Duur: 101s" (audit 1.2.2).
 */
export function opnieuwUitleg(vorige: number | null, volgende: number): string {
  return (
    `De solver kon met een zoektijd van ${zoektijdWoorden(vorige ?? STANDAARD_ZOEKTIJD_SECONDEN)} niet bewijzen dat dit het best mogelijke rooster is. ` +
    `Met ${zoektijdWoorden(volgende)} zoektijd begint de solver helemaal opnieuw: hij zoekt niet verder vanaf dit rooster. ` +
    'Het nieuwe rooster vervangt dit rooster, ook als het niet beter is. Diensten die je met de hand hebt ingevuld, blijven staan.'
  );
}
