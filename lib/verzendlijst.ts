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
 * That e-mail can reach the flow two ways: the planner downloads the JSON
 * and sends it to themselves by hand, or the app sends it itself over SMTP
 * (lib/verzendlijstMail.ts). Both produce the same subject and the same
 * attachment, so one flow handles either.
 *
 * Shared by the client (ExportDialog) and the server, so nothing here may
 * import server-only code.
 */

/** Must match the flow's subject filter exactly. */
export const VERZENDLIJST_SUBJECT = 'DIENSTROOSTER-VERZENDLIJST';

export interface VerzendlijstBericht {
  codenaam: string;
  onderwerp: string;
  tekst: string;
}

export function verzendlijstFilename(periodName: string): string {
  return `dienstrooster-meldingen_${periodName.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.json`;
}

export function verzendlijstJson(berichten: VerzendlijstBericht[]): string {
  return JSON.stringify(berichten, null, 2);
}
