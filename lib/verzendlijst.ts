/**
 * The "verzendlijst": the one contract between Dienstrooster and the Power
 * Automate flow that actually mails people their personal link.
 *
 * Dienstrooster only knows codenamen, never an e-mail address (see
 * CLAUDE.md). The mapping codenaam -> address lives in an Excel sheet on
 * the planner's side, and a Power Automate flow joins the two: it triggers
 * on an e-mail with exactly VERZENDLIJST_SUBJECT as its subject, reads the
 * JSON attachment (a list of VerzendlijstBericht), looks each codenaam up
 * in the sheet and sends that person their own onderwerp + tekst.
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

export interface VerzendlijstBericht {
  codenaam: string;
  personen: string[];
  onderwerp: string;
  tekst: string;
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

export function verzendlijstJson(berichten: VerzendlijstBericht[]): string {
  return JSON.stringify(berichten, null, 2);
}
