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

/**
 * `approved` just swapped its two shifts. Every other PENDING request that
 * involves either shift can no longer be approved:
 *
 * - the approved requester's own other requests (the same shift offered to
 *   several colleagues at once, first come first served) are withdrawn
 *   (INGETROKKEN). Only those colleagues are told: the requester knows,
 *   and is told in the approval mail how many went (`eigenIngetrokken`).
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
): { meldingen: Melding[]; eigenIngetrokken: number } {
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
  let eigenIngetrokken = 0;
  for (const swap of lapsed) {
    if (swap.aanvrager_person_id === approved.aanvrager_person_id) {
      withdraw.run(now, approved.aanvrager_person_id, swap.id);
      eigenIngetrokken++;
      meldingen.push(noticeToColleague(swap, 'ingetrokken', baseUrl, AL_GERUILD_REDEN));
      continue;
    }

    close.run(now, VERVALLEN_REDEN, swap.id);

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
  return { meldingen, eigenIngetrokken };
}
