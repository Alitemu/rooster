/**
 * The verzendlijst of the AIOS: what goes to the AIOS's own Power Automate
 * flow (lib/aiosMail.ts, key aios.mail.verzendlijst_aan). A copy of
 * lib/verzendlijst.ts, not an import of it (docs/development/diensten.md,
 * "Copied, not changed"): the same format today, so the operator can build
 * the AIOS's flow from the achterwacht's, and a later change for the
 * achterwacht's flow never changes what the AIOS's flow gets.
 *
 * The app knows codenamen only, never an e-mail address: the flow looks each
 * bericht's codenaam up in its own sheet and sends that person their own
 * onderwerp and tekst. `personen` lists every codenaam in a text, longest
 * first, for a flow that swaps them for names.
 */

/** Must match the flow's subject filter exactly. */
export const VERZENDLIJST_SUBJECT = 'DIENSTROOSTER-VERZENDLIJST';

/** What a bericht is about, so a flow can treat kinds differently if it wants to. */
export type VerzendlijstSoort =
  | 'UITNODIGING'
  | 'HERINNERING'
  | 'LAATSTE_HERINNERING'
  | 'RUILVERZOEK'
  | 'RUIL_BEVESTIGING'
  | 'RUIL_UITKOMST'
  | 'RUIL_INGETROKKEN'
  | 'RUIL_HERINNERING'
  | 'RUIL_HERINNERING_BEVESTIGING'
  | 'LINK_AANVRAAG'
  | 'ROOSTER_VOORLOPIG'
  | 'ROOSTER_DEFINITIEF'
  | 'RUIL_DOORGEVEN';

export interface VerzendlijstBericht {
  soort: VerzendlijstSoort;
  codenaam: string;
  personen: string[];
  onderwerp: string;
  tekst: string;
  /**
   * Codenamen the flow puts in the CC, only on RUIL_DOORGEVEN (the two who
   * swapped and the Planner). Never an address: the flow looks each up in
   * its own sheet, like `codenaam`. Absent on every other bericht.
   */
  cc?: string[];
}

/**
 * A bericht as it goes out: `html` is `tekst` made safe to put straight
 * into an HTML mail body (every <, >, &, " and ' escaped, line breaks as
 * <br>). The text can hold words a participant typed (a swap toelichting,
 * a rejection reason); put into the mail as raw HTML they could plant a
 * convincing link or button in a mail sent from the planner's own mailbox.
 * The flow uses `html` and never needs to build HTML itself.
 */
export interface VerzendlijstBerichtUit extends VerzendlijstBericht {
  html: string;
}

export function tekstNaarHtml(tekst: string): string {
  return tekst
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, '<br>');
}

/**
 * Whose mailing it is. One flow can serve both diensten: it reads this field
 * and looks the codenamen up in the rows of that dienst (the codenamen of the
 * two never clash, but `Planner` and `Roosterbureau` are one pair per dienst).
 * Set by buildVerzendlijst, never by the caller: a mailing cannot claim to be
 * the other dienst's.
 */
export type VerzendlijstDienst = 'ACHTERWACHT' | 'AIOS';

export interface Verzendlijst {
  /** Which dienst this mailing is of; the flow picks its rows by it. */
  dienst: VerzendlijstDienst;
  /** What this mailing is. Every bericht in it has the same soort. */
  soort: VerzendlijstSoort;
  /** Sent without the planner pressing a button (a scheduled reminder, a swap). */
  automatisch: boolean;
  periode: string;
  /** As stored, and written out in Dutch; null where a deadline doesn't apply (swaps). */
  deadline: string | null;
  deadline_tekst: string | null;
  aantal: number;
  /** Reminders only, otherwise null: how many haven't entered anything / haven't handed in. */
  nog_niets_ingevuld: number | null;
  nog_niet_ingediend: number | null;
  verstuurd_op: string;
  berichten: VerzendlijstBerichtUit[];
  /**
   * LINK_AANVRAAG only, otherwise null: someone asked for their link on the
   * start page with this address (trimmed, lower case). The app cannot tell
   * whose it is - it keeps no addresses - so `berichten` stays empty and
   * `kandidaten` holds a ready bericht for everyone taking part; the flow
   * looks the address up in its own sheet and sends only that person's
   * bericht, to the address in the sheet. Kept out of `berichten` on
   * purpose: a flow that doesn't know this soort yet loops over nothing,
   * instead of mailing everybody their link because a stranger typed an
   * address.
   */
  aanvraag_email: string | null;
  kandidaten: VerzendlijstBerichtUit[] | null;
}

export function buildVerzendlijst(
  meta: {
    soort: VerzendlijstSoort;
    automatisch: boolean;
    periode: string;
    deadline?: string | null;
    groepen?: { nog_niets_ingevuld: number; nog_niet_ingediend: number };
    aanvraag?: { email: string; kandidaten: VerzendlijstBericht[] };
  },
  berichten: VerzendlijstBericht[],
  now: Date = new Date()
): Verzendlijst {
  const uit = (b: VerzendlijstBericht): VerzendlijstBerichtUit => ({ ...b, html: tekstNaarHtml(b.tekst) });
  return {
    dienst: 'AIOS',
    soort: meta.soort,
    automatisch: meta.automatisch,
    periode: meta.periode,
    deadline: meta.deadline ?? null,
    deadline_tekst: meta.deadline ? deadlineTekst(meta.deadline) : null,
    aantal: berichten.length,
    nog_niets_ingevuld: meta.groepen?.nog_niets_ingevuld ?? null,
    nog_niet_ingediend: meta.groepen?.nog_niet_ingediend ?? null,
    verstuurd_op: now.toISOString(),
    berichten: berichten.map(uit),
    aanvraag_email: meta.aanvraag?.email ?? null,
    kandidaten: meta.aanvraag ? meta.aanvraag.kandidaten.map(uit) : null,
  };
}

/** "donderdag 24 september 2026 om 22:00" */
export function deadlineTekst(deadline: string): string {
  return new Date(deadline).toLocaleString('nl-NL', { dateStyle: 'full', timeStyle: 'short' });
}

/** The recipient plus anyone else named in the message: unique, longest first. */
export function verzendlijstPersonen(codenaam: string, anderen: string[] = []): string[] {
  return [...new Set([codenaam, ...anderen].filter((c) => c.length > 0))].sort(
    (a, b) => b.length - a.length || a.localeCompare(b)
  );
}

export function verzendlijstFilename(periodName: string): string {
  return `dienstrooster-meldingen_${periodName.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.json`;
}

export function verzendlijstJson(lijst: Verzendlijst): string {
  return JSON.stringify(lijst, null, 2);
}
