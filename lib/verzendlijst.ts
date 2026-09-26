/**
 * The "verzendlijst": the one contract between Dienstrooster and the Power
 * Automate flow that actually mails people their personal link.
 *
 * Dienstrooster only knows codenamen, never an e-mail address (see
 * CLAUDE.md). The mapping codenaam -> address lives in an Excel sheet on
 * the planner's side, and a Power Automate flow joins the two: it triggers
 * on an e-mail with exactly VERZENDLIJST_SUBJECT as its subject, reads the
 * JSON attachment (a Verzendlijst), looks each bericht's codenaam up in the
 * sheet and sends that person their own onderwerp + tekst.
 *
 * The fields around the berichten are the summary: what kind of mailing it
 * was, for which period, how many, and for reminders how many in each
 * group. The flow uses them to report back to the planner itself, so there
 * is no separate summary mail. (The attachment used to be a bare list of
 * berichten; a flow built for that reads `berichten` now.)
 *
 * `personen` lists every codenaam that appears in onderwerp/tekst, the
 * recipient's own included, so a flow that also keeps real names in its
 * sheet can swap each one for the name. Longest first: replaced in that
 * order, "Persoon-10" is gone before "Persoon-1" could match inside it. A
 * flow that ignores the field keeps working unchanged.
 *
 * The server sends that e-mail itself over SMTP (lib/verzendlijstMail.ts).
 * There used to be a manual route too (download the JSON, attach it to a
 * mail to yourself), and per-person mailto links; both are gone, so every
 * mail to a participant now goes through the flow.
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
  | 'LINK_AANVRAAG';

export interface VerzendlijstBericht {
  soort: VerzendlijstSoort;
  codenaam: string;
  personen: string[];
  onderwerp: string;
  tekst: string;
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

export interface Verzendlijst {
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
