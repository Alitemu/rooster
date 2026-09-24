/**
 * What happens to a swap request besides being approved or rejected by
 * the colleague it was sent to:
 *
 * - INGETROKKEN: the requester takes it back. The colleague had been told
 *   "X wants to swap with you" (in the app, and by mail), so they are told
 *   it is off, rather than finding out by pressing approve.
 * - Vervallen: another swap already moved one of its two shifts. It can
 *   never be approved any more (the approve route checks who holds the
 *   shifts), so it is closed instead of sitting "in behandeling" forever;
 *   see closeLapsedSwaps for who is told what.
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

interface SwapRow {
  id: string;
  periode_id: string;
  aanvrager_person_id: string;
  respondent_person_id: string;
  aangeboden_slot_id: string;
  gevraagde_slot_id: string;
}

/** For the colleague: the request is off. {{wat}} = "ingetrokken" or "vervallen". */
export const SWAP_WITHDRAWN_TEMPLATE = {
  naam: 'SWAP_WITHDRAWN',
  onderwerp: 'Het ruilverzoek van {{aanvrager}} is {{wat}}',
  tekst:
    'Hoi {{codenaam}},\n\nHet ruilverzoek van {{aanvrager}} is {{wat}}. Je hoeft er niets meer mee te doen.' +
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
function noticeToColleague(swap: SwapRow, wat: 'ingetrokken' | 'vervallen', baseUrl: string, reden?: string): Melding {
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
        template: SWAP_WITHDRAWN_TEMPLATE,
        placeholders,
        anderen: [aanvrager],
        soort: 'RUIL_INGETROKKEN',
        linkIntro: 'Bekijk je rooster via je persoonlijke link:',
        baseUrl,
      }),
  };
}

/**
 * The requester withdrew `swap`: tell the colleague. Call inside the
 * transaction that sets INGETROKKEN; call `.send()` on the result after it.
 */
export function noticeWithdrawn(swap: SwapRow, baseUrl: string): Melding {
  return noticeToColleague(swap, 'ingetrokken', baseUrl);
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
 * - anyone else's request for one of the two shifts lapses: AFGEWEZEN with
 *   VERVALLEN_REDEN, and both sides are told.
 *
 * Call inside the approving transaction; call `.send()` on each melding
 * after it.
 */
export function closeLapsedSwaps(
  approved: SwapRow,
  now: string,
  baseUrl: string
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
  const close = db.prepare(
    `UPDATE dienstrooster_swap_request
     SET status = 'AFGEWEZEN', beantwoord_op = ?, reden_afwijzing = ?
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
      meldingen.push(noticeToColleague(swap, 'ingetrokken', baseUrl, reden));
      continue;
    }

    close.run(now, VERVALLEN_REDEN, swap.id);
    afgesloten.push({ id: swap.id, status: 'AFGEWEZEN' });

    // The requester: their request lapsed.
    const aanvrager = codenaamOf(swap.aanvrager_person_id);
    const collega = codenaamOf(swap.respondent_person_id);
    const details = swapMailDetails({
      lezer: 'aanvrager',
      aanvrager,
      collega,
      aangeboden: shiftOf(swap.aangeboden_slot_id),
      gevraagd: shiftOf(swap.gevraagde_slot_id),
      afgewezen: true,
      redenAfwijzing: VERVALLEN_REDEN,
    });
    insertNotification({
      personId: swap.aanvrager_person_id,
      periodId: swap.periode_id,
      type: 'RUIL_AFGEWEZEN',
      onderwerp: 'Je ruilverzoek is vervallen',
      inhoud: `Hoi ${aanvrager},\n\nJe ruilverzoek is vervallen.\n\n${details}`,
    });
    meldingen.push({
      send: () =>
        void mailMelding({
          swapId: swap.id,
          personId: swap.aanvrager_person_id,
          periodId: swap.periode_id,
          template: { sleutel: 'SWAP_RESULT' },
          placeholders: { codenaam: aanvrager, uitkomst: 'vervallen', details },
          anderen: [collega],
          soort: 'RUIL_UITKOMST',
          linkIntro: 'Bekijk je rooster via je persoonlijke link:',
          baseUrl,
        }),
    });

    // The colleague: the request they were asked about is off.
    meldingen.push(noticeToColleague(swap, 'vervallen', baseUrl, VERVALLEN_REDEN));
  }
  return { meldingen, eigenIngetrokken, afgesloten };
}
