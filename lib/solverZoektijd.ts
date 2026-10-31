/**
 * How long the achterwacht's solver searches, and the words of "Rooster genereren"
 * (components/RosterGenerationDialog.tsx) about it.
 *
 * A first run searches 5 minutes (0.905.0; 2 minutes until then). On the
 * planner's period of October 2026 2 minutes left one shift empty and 5 filled
 * them all. After a result the solver could not prove best (FEASIBLE), the
 * dialog offers 10 minutes, then 30 (the planner's choice; solver/main.py
 * takes up to 1800 seconds since 0.905.0). That is a new run from the start,
 * not more time on top of the last one: it does not go on from the roster on
 * screen, and its roster replaces that one even when it is not better
 * (generate-roster/route.ts clearSolverAssignments). Diensten filled in by hand
 * stay. Until 0.904.0 the button said "5 minuten langer proberen", which read
 * as 2 + 5 minutes going on from where it stopped.
 */

/** The search time of a first run: generate-roster/route.ts sends it when the planner asked for none. */
export const STANDAARD_ZOEKTIJD_SECONDEN = 300;
/** The longest search on offer, and what the route and solver/main.py take. */
export const MAX_ZOEKTIJD_SECONDEN = 1800;

export function zoektijdWoorden(seconden: number): string {
  if (seconden < 60) return `${seconden} seconden`;
  const minuten = Math.round(seconden / 60);
  return `${minuten} ${minuten === 1 ? 'minuut' : 'minuten'}`;
}

/** The next search time offered after a FEASIBLE result: 10 minutes after the first run, then 30, then none. */
export function volgendeZoektijd(vorige: number | null): number | null {
  const was = vorige ?? STANDAARD_ZOEKTIJD_SECONDEN;
  return was < 600 ? 600 : was < MAX_ZOEKTIJD_SECONDEN ? MAX_ZOEKTIJD_SECONDEN : null;
}

/**
 * What the route sends the solver: the planner's choice, else the first run's 5 minutes for the two ways that run
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

/** Above that button: why, and that it starts over. */
export function opnieuwUitleg(vorige: number | null, volgende: number): string {
  return (
    `De solver had na ${zoektijdWoorden(vorige ?? STANDAARD_ZOEKTIJD_SECONDEN)} nog niet bewezen dat dit het best mogelijke rooster is. ` +
    `Met ${zoektijdWoorden(volgende)} zoektijd begint de solver helemaal opnieuw: hij zoekt niet verder vanaf dit rooster. ` +
    'Het nieuwe rooster vervangt dit rooster, ook als het niet beter is. Diensten die je met de hand hebt ingevuld, blijven staan.'
  );
}
