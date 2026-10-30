/**
 * The words of "Rooster genereren" (components/RosterGenerationDialog.tsx) about
 * how long the achterwacht's solver searches, and what a longer search does.
 *
 * A first run searches 2 minutes. After a result the solver could not prove
 * best (FEASIBLE), the dialog offers 5 minutes, then 10. That is a new run
 * from the start, not more time on top of the last one: it does not go on
 * from the roster on screen, and its roster replaces that one even when it
 * is not better (generate-roster/route.ts clearSolverAssignments). Diensten
 * filled in by hand stay. Until 0.904.0 the button said "5 minuten langer
 * proberen", which read as 2 + 5 minutes going on from where it stopped.
 */

/** The search time of a first run (solver/main.py time_limit_seconds' default). */
export const STANDAARD_ZOEKTIJD_SECONDEN = 120;

export function zoektijdWoorden(seconden: number): string {
  if (seconden < 60) return `${seconden} seconden`;
  const minuten = Math.round(seconden / 60);
  return `${minuten} ${minuten === 1 ? 'minuut' : 'minuten'}`;
}

/** The next search time offered after a FEASIBLE result: 5 minutes, then 10, then none. */
export function volgendeZoektijd(vorige: number | null): number | null {
  return vorige === null ? 300 : vorige === 300 ? 600 : null;
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
