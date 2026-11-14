/**
 * What a participant of the achterwacht has to answer (1.5.0).
 *
 * A request from a colleague sat behind two taps: open Ruilen, then
 * "Ruilverzoeken bekijken". Nothing on the page said it was there, and
 * Goedkeuren moved both shifts at one tap with no way back. The header of
 * Ruilen now says how many wait, the list is open when one does, and
 * approving asks first.
 *
 * No db import: components/PersonalRosterView.tsx and
 * components/SwapManagementPanel.tsx import this in the browser.
 */

export interface RuilVerzoekKort {
  status: string;
  respondent_person_id: string;
}

/** The requests of colleagues this person has not answered yet. */
export function aantalWachtend(verzoeken: ReadonlyArray<RuilVerzoekKort>, personId: string): number {
  return verzoeken.filter((v) => v.status === 'PENDING' && v.respondent_person_id === personId).length;
}

/** The words beside "Ruilen", or nothing when no request waits. */
export function wachtHint(aantal: number): string | undefined {
  if (aantal <= 0) return undefined;
  return aantal === 1 ? '1 verzoek wacht op je antwoord' : `${aantal} verzoeken wachten op je antwoord`;
}

/**
 * The question before a swap is approved, from the side of the one who
 * approves: they give the shift that was asked for and get the one that
 * was offered.
 */
export function goedkeurVraag(ruil: { geef: string; krijg: string; van: string }): string {
  return `Je geeft je dienst op ${ruil.geef} aan ${ruil.van} en krijgt de dienst op ${ruil.krijg}. Daarna is de ruil definitief.`;
}
