/**
 * Mails an in-app notification (a swap request, its outcome) through the
 * same verzendlijst as the invitations (lib/verzendlijst.ts), so the Power
 * Automate flow delivers it to the person's own address without any change
 * on that side: it is simply a verzendlijst with one bericht in it.
 *
 * The in-app notification stays the record. This is an extra nudge, so it
 * only happens when the server is set up to send (lib/verzendlijstMail.ts)
 * and it never holds up or fails the request that caused it: the caller
 * starts it and moves on, and a failure is only logged.
 *
 * The mail carries a fresh personal link for that period. The plaintext of
 * any earlier link isn't stored, so it can't be reused here, and a mail
 * saying "someone wants to swap" is only useful if it opens the request.
 */

import { db } from '@/db/client';
import { issuePersonLink } from './periodInvitations';
import { renderNotificationTemplate, renderTemplate } from './notifications';
import { sendVerzendlijst, verzendlijstMailConfigured } from './verzendlijstMail';
import { verzendlijstPersonen, type VerzendlijstSoort } from './verzendlijst';

export interface MeldingMail {
  personId: string;
  periodId: string;
  /**
   * A stored template (dienstrooster_notification_template.sleutel), or the
   * text itself for a mail that has no in-app counterpart - the requester's
   * own confirmation. Both use {{placeholders}}, including {{link}}.
   */
  template: { sleutel: string } | { naam: string; onderwerp: string; tekst: string };
  placeholders: Record<string, string>;
  /** Other people's codenamen the text mentions (the reader's own is added). */
  anderen: string[];
  soort: VerzendlijstSoort;
  /** The sentence above the link, e.g. "Bekijk het verzoek via je persoonlijke link:". */
  linkIntro: string;
  baseUrl: string;
}

/** Resolves once the mail is sent, skipped or has failed. Never rejects. */
export async function mailMelding(melding: MeldingMail): Promise<void> {
  try {
    if (!verzendlijstMailConfigured()) return;

    const person = db
      .prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?')
      .get(melding.personId) as { codenaam: string } | undefined;
    const period = db
      .prepare('SELECT naam FROM dienstrooster_schedule_period WHERE id = ?')
      .get(melding.periodId) as { naam: string } | undefined;
    if (!person || !period) return;

    const link = issuePersonLink(melding.personId, melding.periodId, melding.baseUrl);
    const placeholders = { ...melding.placeholders, link: `${melding.linkIntro}\n${link}` };
    const rendered =
      'sleutel' in melding.template
        ? renderNotificationTemplate(melding.template.sleutel, placeholders)
        : {
            onderwerp: renderTemplate(melding.template.onderwerp, placeholders),
            inhoud: renderTemplate(melding.template.tekst, placeholders),
          };
    if (!rendered) return;

    const result = await sendVerzendlijst(period.naam, [
      {
        soort: melding.soort,
        codenaam: person.codenaam,
        personen: verzendlijstPersonen(person.codenaam, melding.anderen),
        onderwerp: rendered.onderwerp,
        // The templates use **bold** for the in-app view; a plain-text
        // mail would show the asterisks.
        tekst: rendered.inhoud.replace(/\*\*(.+?)\*\*/g, '$1'),
      },
    ]);
    if (!result.ok) console.error(`[melding-mail] ${templateName(melding)} not sent: ${result.message}`);
  } catch (error) {
    console.error(`[melding-mail] ${templateName(melding)} failed`, error);
  }
}

function templateName(melding: MeldingMail): string {
  return 'sleutel' in melding.template ? melding.template.sleutel : melding.template.naam;
}

/** The requester's confirmation that their swap request went out. */
export const SWAP_SUBMITTED_TEMPLATE = {
  naam: 'SWAP_SUBMITTED',
  onderwerp: 'Je ruilverzoek aan {{respondent}} is verstuurd',
  tekst:
    'Hoi {{codenaam}},\n\nJe ruilverzoek aan {{respondent}} is verstuurd.\n\n{{details}}\n\n' +
    'Je krijgt een mail zodra {{respondent}} het verzoek heeft goedgekeurd of afgewezen. ' +
    'Tot die tijd blijft je rooster zoals het is.\n\n{{link}}',
};
