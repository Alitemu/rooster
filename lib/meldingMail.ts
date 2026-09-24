/**
 * Mails an in-app notification (a swap request, its outcome) through the
 * same verzendlijst as the invitations (lib/verzendlijst.ts), so the Power
 * Automate flow delivers it to the person's own address without any change
 * on that side: it is simply a verzendlijst with one bericht in it.
 *
 * The in-app notification stays the record. This is an extra nudge: it
 * never holds up or fails the request that caused it (the caller starts it
 * and moves on). A mail that can't go out right now - sending not set up,
 * or the mail server refusing - waits in dienstrooster_mail_queue and is
 * sent later by flushMailQueue: every hour, and right after new mail
 * settings are saved. Dropped after 7 days, or as soon as the swap has
 * moved on (see stillRelevant).
 *
 * The mail carries a fresh personal link for that period. The plaintext of
 * any earlier link isn't stored, so it can't be reused here, and a mail
 * saying "someone wants to swap" is only useful if it opens the request.
 */

import { db } from '@/db/client';
import { issuePersonLink } from './periodInvitations';
import { renderNotificationTemplate, renderTemplate } from './notifications';
import { sendVerzendlijst, verzendlijstMailConfigured } from './verzendlijstMail';
import { buildVerzendlijst, verzendlijstPersonen, type VerzendlijstSoort } from './verzendlijst';

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
  /** The swap request this mail is about, so a queued mail can be dropped once it no longer applies. */
  swapId?: string;
}

/** How long a queued mail is still worth sending. */
export const MAIL_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Mails about a request that is still open: pointless once it was answered, withdrawn or lapsed. */
const ONLY_WHILE_PENDING = new Set<VerzendlijstSoort>(['RUILVERZOEK', 'RUIL_BEVESTIGING']);

type Delivery = 'SENT' | 'FAILED' | 'GONE';

/** Builds the mail (with a fresh personal link) and sends it. GONE: the person, period or template no longer exists. */
async function deliver(melding: MeldingMail): Promise<Delivery> {
  const person = db
    .prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?')
    .get(melding.personId) as { codenaam: string } | undefined;
  const period = db
    .prepare('SELECT naam FROM dienstrooster_schedule_period WHERE id = ?')
    .get(melding.periodId) as { naam: string } | undefined;
  if (!person || !period) return 'GONE';

  const link = issuePersonLink(melding.personId, melding.periodId, melding.baseUrl);
  const placeholders = { ...melding.placeholders, link: `${melding.linkIntro}\n${link}` };
  const rendered =
    'sleutel' in melding.template
      ? renderNotificationTemplate(melding.template.sleutel, placeholders)
      : {
          onderwerp: renderTemplate(melding.template.onderwerp, placeholders),
          inhoud: renderTemplate(melding.template.tekst, placeholders),
        };
  if (!rendered) return 'GONE';

  const result = await sendVerzendlijst(
    // Automatisch: it goes out because a participant did something, not
    // because the planner pressed a button.
    buildVerzendlijst({ soort: melding.soort, automatisch: true, periode: period.naam }, [
      {
        soort: melding.soort,
        codenaam: person.codenaam,
        personen: verzendlijstPersonen(person.codenaam, melding.anderen),
        onderwerp: rendered.onderwerp,
        // The templates use **bold** for the in-app view; a plain-text
        // mail would show the asterisks.
        tekst: rendered.inhoud.replace(/\*\*(.+?)\*\*/g, '$1'),
      },
    ])
  );
  if (!result.ok) {
    console.error(`[melding-mail] ${templateName(melding)} not sent: ${result.message}`);
    return 'FAILED';
  }
  return 'SENT';
}

function enqueue(melding: MeldingMail): void {
  db.prepare(
    `INSERT INTO dienstrooster_mail_queue (id, period_id, swap_id, soort, melding_json, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    melding.periodId,
    melding.swapId ?? null,
    melding.soort,
    JSON.stringify(melding),
    new Date().toISOString()
  );
}

/**
 * A request is off (withdrawn or lapsed) before its mails ever went out:
 * drop them. Returns whether the colleague's request mail was among them -
 * then they never heard of it, and a mail saying it is off would only
 * confuse.
 */
function dropQueuedRequest(swapId: string): boolean {
  const removed = db
    .prepare(
      `DELETE FROM dienstrooster_mail_queue WHERE swap_id = ? AND soort IN ('RUILVERZOEK', 'RUIL_BEVESTIGING')
       RETURNING soort`
    )
    .all(swapId) as Array<{ soort: string }>;
  return removed.some((r) => r.soort === 'RUILVERZOEK');
}

/** Resolves once the mail is sent, queued or skipped. Never rejects. */
export async function mailMelding(melding: MeldingMail): Promise<void> {
  try {
    if (melding.soort === 'RUIL_INGETROKKEN' && melding.swapId && dropQueuedRequest(melding.swapId)) return;
    if (!verzendlijstMailConfigured()) {
      enqueue(melding);
      return;
    }
    if ((await deliver(melding)) === 'FAILED') enqueue(melding);
  } catch (error) {
    console.error(`[melding-mail] ${templateName(melding)} failed`, error);
  }
}

export function queuedMailCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_mail_queue').get() as { n: number }).n;
}

function stillRelevant(soort: string, swapId: string | null): boolean {
  if (!ONLY_WHILE_PENDING.has(soort as VerzendlijstSoort) || !swapId) return true;
  const swap = db.prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as
    | { status: string }
    | undefined;
  return swap?.status === 'PENDING';
}

let flushing = false;

/**
 * Sends what waits in the queue, oldest first. Stops at the first failure
 * (the mail server is still refusing; the next run tries again) and drops
 * what is too old or no longer applies. Does nothing while sending isn't
 * set up. One run at a time.
 */
export async function flushMailQueue(now: Date = new Date()): Promise<{ verstuurd: number; vervallen: number; over: number }> {
  const result = { verstuurd: 0, vervallen: 0, over: 0 };
  if (flushing || !verzendlijstMailConfigured()) {
    result.over = queuedMailCount();
    return result;
  }
  flushing = true;
  try {
    const rows = db
      .prepare('SELECT id, swap_id, soort, melding_json, aangemaakt_op FROM dienstrooster_mail_queue ORDER BY aangemaakt_op, rowid')
      .all() as Array<{ id: string; swap_id: string | null; soort: string; melding_json: string; aangemaakt_op: string }>;
    const remove = db.prepare('DELETE FROM dienstrooster_mail_queue WHERE id = ?');
    for (const row of rows) {
      if (now.getTime() - Date.parse(row.aangemaakt_op) > MAIL_QUEUE_MAX_AGE_MS || !stillRelevant(row.soort, row.swap_id)) {
        remove.run(row.id);
        result.vervallen++;
        continue;
      }
      db.prepare(
        'UPDATE dienstrooster_mail_queue SET pogingen = pogingen + 1, laatste_poging_op = ? WHERE id = ?'
      ).run(now.toISOString(), row.id);
      const delivery = await deliver(JSON.parse(row.melding_json) as MeldingMail);
      if (delivery === 'FAILED') break;
      remove.run(row.id);
      if (delivery === 'SENT') result.verstuurd++;
    }
  } catch (error) {
    console.error('[melding-mail] wachtrij versturen mislukt', error);
  } finally {
    flushing = false;
  }
  result.over = queuedMailCount();
  return result;
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
