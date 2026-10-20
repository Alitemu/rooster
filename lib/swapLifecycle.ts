/**
 * What happens to a swap request besides being approved or rejected by
 * the colleague it was sent to:
 *
 * - INGETROKKEN: the requester takes it back. The colleague had been told
 *   about it (in the app, and by mail), so they are told it is off, rather
 *   than finding out by pressing approve.
 *
 * None of these mails names the other side: the swap did not go through
 * (lib/swapMailDetails.ts). The in-app notices may, codenamen being
 * pseudonyms.
 * - Another swap already moved one of its two shifts, or the planner changed
 *   the roster. It can never be approved any more (the approve route checks
 *   who holds the shifts), so it is withdrawn instead of sitting "in
 *   behandeling" forever; see closeLapsedSwaps and closeSwapsAfterRosterChange
 *   for who is told what. There is no status "vervallen": it is INGETROKKEN.
 *
 * Status changes and in-app notices are written inside the caller's
 * transaction; mails go out after the commit, like every swap mail
 * (lib/meldingMail.ts).
 */

import { db } from '@/db/client';
import { insertNotification, renderTemplate } from './notifications';
import { mailMelding } from './meldingMail';
import { swapMailDetails, type SwapShift } from './swapMailDetails';

export const VERVALLEN_REDEN = 'Een van de diensten is intussen al met iemand anders geruild.';
/** Why a request is withdrawn when the planner changed the roster or took it back to voorlopig. */
export const ROOSTER_AANGEPAST_REDEN = 'Het rooster is aangepast.';

interface SwapRow {
  id: string;
  periode_id: string;
  aanvrager_person_id: string;
  respondent_person_id: string;
  aangeboden_slot_id: string;
  gevraagde_slot_id: string;
}

/** For the colleague, in the app: the request is off. {{wat}} = "ingetrokken" or "vervallen". */
export const SWAP_WITHDRAWN_TEMPLATE = {
  naam: 'SWAP_WITHDRAWN',
  onderwerp: 'Het ruilverzoek van {{aanvrager}} is {{wat}}',
  tekst:
    'Beste {{codenaam}},\n\nHet ruilverzoek van {{aanvrager}} is {{wat}}. Je hoeft er niets meer mee te doen.' +
    '\n\n{{details}}\n\n{{link}}',
};

/** The same by mail, without naming the requester. */
export const SWAP_WITHDRAWN_MAIL_TEMPLATE = {
  naam: 'SWAP_WITHDRAWN_MAIL',
  onderwerp: 'Een ruilverzoek aan jou is {{wat}}',
  tekst:
    'Beste {{codenaam}},\n\nEen ruilverzoek aan jou is {{wat}}. Je hoeft er niets meer mee te doen.' +
    '\n\n{{details}}\n\n{{link}}',
};

function codenaamOf(personId: string): string {
  return (
    (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(personId) as { codenaam: string } | undefined)
      ?.codenaam ?? ''
  );
}

function shiftOf(slotId: string): SwapShift {
  return (
    (db
      .prepare(
        `SELECT s.datum, st.teller FROM dienstrooster_shift_slot s
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id WHERE s.id = ?`
      )
      .get(slotId) as SwapShift | undefined) ?? { datum: '', teller: '' }
  );
}

interface Melding {
  send: () => void;
}

/** The colleague's notice that a request aimed at them is off. Call inside the transaction. */
function noticeToColleague(swap: SwapRow, wat: 'ingetrokken' | 'vervallen', reden?: string): Melding {
  const aanvrager = codenaamOf(swap.aanvrager_person_id);
  const collega = codenaamOf(swap.respondent_person_id);
  const details = swapMailDetails({
    lezer: 'collega',
    aanvrager,
    collega,
    aangeboden: shiftOf(swap.aangeboden_slot_id),
    gevraagd: shiftOf(swap.gevraagde_slot_id),
    afgewezen: true,
    redenAfwijzing: reden ?? null,
  });
  const placeholders = { codenaam: collega, aanvrager, wat, details };
  insertNotification({
    personId: swap.respondent_person_id,
    periodId: swap.periode_id,
    type: 'RUILVERZOEK',
    onderwerp: renderTemplate(SWAP_WITHDRAWN_TEMPLATE.onderwerp, placeholders),
    inhoud: renderTemplate(SWAP_WITHDRAWN_TEMPLATE.tekst, { ...placeholders, link: '' }).trim(),
  });
  return {
    send: () =>
      void mailMelding({
        swapId: swap.id,
        personId: swap.respondent_person_id,
        periodId: swap.periode_id,
        template: SWAP_WITHDRAWN_MAIL_TEMPLATE,
        placeholders: { codenaam: collega, wat, details },
        anderen: [],
        soort: 'RUIL_INGETROKKEN',
        linkIntro: 'Bekijk je rooster via je persoonlijke link:',
      }),
  };
}

/** The requester's notice that their own request is off, in the app and by mail. Call inside the transaction. */
function noticeToRequester(swap: SwapRow, reden: string): Melding {
  const aanvrager = codenaamOf(swap.aanvrager_person_id);
  const collega = codenaamOf(swap.respondent_person_id);
  const details = swapMailDetails({
    lezer: 'aanvrager',
    aanvrager,
    collega,
    aangeboden: shiftOf(swap.aangeboden_slot_id),
    gevraagd: shiftOf(swap.gevraagde_slot_id),
    afgewezen: true,
    redenAfwijzing: reden,
  });
  insertNotification({
    personId: swap.aanvrager_person_id,
    periodId: swap.periode_id,
    type: 'RUIL_AFGEWEZEN',
    onderwerp: 'Je ruilverzoek is ingetrokken',
    inhoud: `Beste ${aanvrager},\n\nJe ruilverzoek is ingetrokken.\n\n${details}`,
  });
  return {
    send: () =>
      void mailMelding({
        swapId: swap.id,
        personId: swap.aanvrager_person_id,
        periodId: swap.periode_id,
        template: { sleutel: 'SWAP_RESULT' },
        placeholders: { codenaam: aanvrager, uitkomst: 'ingetrokken', details },
        anderen: [],
        soort: 'RUIL_UITKOMST',
        linkIntro: 'Bekijk je rooster via je persoonlijke link:',
      }),
  };
}

/**
 * The requester withdrew `swap`: tell the colleague. Call inside the
 * transaction that sets INGETROKKEN; call `.send()` on the result after it.
 */
export function noticeWithdrawn(swap: SwapRow): Melding {
  return noticeToColleague(swap, 'ingetrokken');
}

/** Why the colleague is told a request is off, when the requester had already swapped elsewhere. */
export const AL_GERUILD_REDEN = 'De dienst is al met een andere collega geruild.';
/** The same, when the colleague was the other side of that swap themselves. */
export const AL_ONDERLING_GERUILD_REDEN = 'Jullie hebben die dienst intussen via een ander ruilverzoek al met elkaar geruild.';

/**
 * `approved` just swapped its two shifts. Every other PENDING request that
 * involves either shift can no longer be approved:
 *
 * - a request made by one of the two who just swapped (the same shift
 *   offered to several colleagues at once, first come first served, or the
 *   approver's own offer of the shift they just gave away) is withdrawn
 *   (INGETROKKEN). Only the colleague it was sent to is told: the one who
 *   made it just took part in the swap. The approved requester is told in
 *   the approval mail how many went (`eigenIngetrokken`), the approver on
 *   screen (`afgesloten`).
 * - anyone else's request for one of the two shifts is withdrawn as well
 *   (INGETROKKEN, with VERVALLEN_REDEN as the reason), and both sides are told.
 *
 * Call inside the approving transaction; call `.send()` on each melding
 * after it.
 */
export function closeLapsedSwaps(
  approved: SwapRow,
  now: string
): { meldingen: Melding[]; eigenIngetrokken: number; afgesloten: Array<{ id: string; status: string }> } {
  const lapsed = db
    .prepare(
      `SELECT id, periode_id, aanvrager_person_id, respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
       FROM dienstrooster_swap_request
       WHERE periode_id = ? AND status = 'PENDING' AND id != ?
         AND (aangeboden_slot_id IN (?, ?) OR gevraagde_slot_id IN (?, ?))`
    )
    .all(
      approved.periode_id,
      approved.id,
      approved.aangeboden_slot_id,
      approved.gevraagde_slot_id,
      approved.aangeboden_slot_id,
      approved.gevraagde_slot_id
    ) as SwapRow[];

  const withdraw = db.prepare(
    `UPDATE dienstrooster_swap_request
     SET status = 'INGETROKKEN', beantwoord_op = ?, afgehandeld_door_person_id = ?
     WHERE id = ? AND status = 'PENDING'`
  );
  // Someone else's request for one of the two shifts: nobody rejected it, it is off (ingetrokken), with the reason.
  const close = db.prepare(
    `UPDATE dienstrooster_swap_request
     SET status = 'INGETROKKEN', beantwoord_op = ?, reden_afwijzing = ?
     WHERE id = ? AND status = 'PENDING'`
  );
  const meldingen: Melding[] = [];
  const afgesloten: Array<{ id: string; status: string }> = [];
  let eigenIngetrokken = 0;
  const partijen = [approved.aanvrager_person_id, approved.respondent_person_id];
  for (const swap of lapsed) {
    if (partijen.includes(swap.aanvrager_person_id)) {
      withdraw.run(now, swap.aanvrager_person_id, swap.id);
      afgesloten.push({ id: swap.id, status: 'INGETROKKEN' });
      if (swap.aanvrager_person_id === approved.aanvrager_person_id) eigenIngetrokken++;
      const reden = partijen.includes(swap.respondent_person_id) ? AL_ONDERLING_GERUILD_REDEN : AL_GERUILD_REDEN;
      meldingen.push(noticeToColleague(swap, 'ingetrokken', reden));
      continue;
    }

    close.run(now, VERVALLEN_REDEN, swap.id);
    afgesloten.push({ id: swap.id, status: 'INGETROKKEN' });

    // The requester: their request is off.
    meldingen.push(noticeToRequester(swap, VERVALLEN_REDEN));

    // The colleague: the request they were asked about is off.
    meldingen.push(noticeToColleague(swap, 'ingetrokken', VERVALLEN_REDEN));
  }
  return { meldingen, eigenIngetrokken, afgesloten };
}

/**
 * The planner changed the roster (a dienst by hand, or the publication was
 * taken back): open requests whose two shifts are no longer held by the two
 * people they are about can never be approved, so they are withdrawn
 * (INGETROKKEN, ROOSTER_AANGEPAST_REDEN). With `alle`, every open request
 * of the period goes, for the roster that stops being definitief.
 * Both the requester and the colleague are told, without naming the other.
 *
 * Call inside the transaction that changed the roster; call `.send()` on
 * each melding after it.
 */
export function closeSwapsAfterRosterChange(periodId: string, now: string, opties: { alle?: boolean } = {}): { meldingen: Melding[]; aantal: number } {
  const open = db
    .prepare(
      `SELECT sr.id, sr.periode_id, sr.aanvrager_person_id, sr.respondent_person_id, sr.aangeboden_slot_id, sr.gevraagde_slot_id,
              (SELECT person_id FROM dienstrooster_assignment WHERE schedule_version_id = sr.periode_id AND slot_id = sr.aangeboden_slot_id) AS houdt_aangeboden,
              (SELECT person_id FROM dienstrooster_assignment WHERE schedule_version_id = sr.periode_id AND slot_id = sr.gevraagde_slot_id) AS houdt_gevraagd
       FROM dienstrooster_swap_request sr
       WHERE sr.periode_id = ? AND sr.status = 'PENDING'`
    )
    .all(periodId) as Array<SwapRow & { houdt_aangeboden: string | null; houdt_gevraagd: string | null }>;
  const weg = open.filter(
    (r) => opties.alle || r.houdt_aangeboden !== r.aanvrager_person_id || r.houdt_gevraagd !== r.respondent_person_id
  );
  const trekIn = db.prepare(
    `UPDATE dienstrooster_swap_request
     SET status = 'INGETROKKEN', beantwoord_op = ?, reden_afwijzing = ?
     WHERE id = ? AND status = 'PENDING'`
  );
  const meldingen: Melding[] = [];
  for (const swap of weg) {
    trekIn.run(now, ROOSTER_AANGEPAST_REDEN, swap.id);
    meldingen.push(noticeToRequester(swap, ROOSTER_AANGEPAST_REDEN));
    meldingen.push(noticeToColleague(swap, 'ingetrokken', ROOSTER_AANGEPAST_REDEN));
  }
  return { meldingen, aantal: weg.length };
}
