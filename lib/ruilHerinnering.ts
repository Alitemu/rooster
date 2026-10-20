/**
 * Reminders for swap requests that wait for an answer (the achterwacht's;
 * the AIOS has its own copy in lib/aiosRuilen.ts).
 *
 * Automatic: a request open 7 x 24 hours, rounded down to 09:00, is
 * reminded once, by the hourly check. A request made on a Friday afternoon
 * is reminded the next Friday morning, never on the Saturday. Not when
 * anyone (the requester, the planner) already reminded.
 *
 * By hand: the requester for their own request, the planner for any in
 * their dienst, only after their yes (`bevestigd`), which shows when the
 * last one went; not within 24 hours of the last.
 *
 * Every reminder is two berichten: the colleague is reminded (without the
 * requester's name, like the request itself), and the requester is told it
 * was done, with the advice to consider another day or colleague, that
 * more than one request is possible, and that the others are withdrawn
 * when someone accepts. In the app as a notice too, as every swap mail.
 * Only on a definitief roster, for an open request, for diensten still to
 * come.
 */

import { db } from '@/db/client';
import { insertNotification } from '@/lib/notifications';
import { mailMelding } from '@/lib/meldingMail';
import { swapMailDetails, type SwapShift } from '@/lib/swapMailDetails';
import { writeAuditLog } from '@/lib/auditLog';

const UUR_MS = 60 * 60 * 1000;
const DAG_MS = 24 * UUR_MS;
/** The hour of day (server-local) an automatic reminder goes out. */
const HERINNERING_UUR = 9;
/** After this many days open (rounded down to 09:00) the colleague is reminded once, automatically. */
export const HERINNERING_NA_DAGEN = 7;
/** By hand not more often than this: the colleague is not to be pestered. */
export const HERINNERING_MIN_TUSSENTIJD_MS = DAG_MS;

export type HerinneringDoor = 'AUTOMATISCH' | 'AANVRAGER' | 'PLANNER';

/**
 * The last 09:00 (server-local) at or before the request is 7 x 24 hours
 * old: made Friday 15:00, it is reminded the next Friday 09:00; made Friday
 * 08:00, the Thursday 09:00 before.
 */
export function ruilHerinneringMoment(aangemaaktOp: string): Date {
  const rijp = new Date(Date.parse(aangemaaktOp) + HERINNERING_NA_DAGEN * DAG_MS);
  const moment = new Date(rijp);
  moment.setHours(HERINNERING_UUR, 0, 0, 0);
  if (moment > rijp) moment.setDate(moment.getDate() - 1);
  return moment;
}

interface RuilRij {
  id: string;
  periode_id: string;
  aanvrager_person_id: string;
  respondent_person_id: string;
  status: string;
  opmerkingen: string | null;
  laatste_herinnering_op: string | null;
  aangemaakt_op: string;
  aangeboden_datum: string;
  aangeboden_teller: string;
  gevraagd_datum: string;
  gevraagd_teller: string;
  periode_naam: string;
  aanvrager: string;
  collega: string;
}

const SELECT = `SELECT sr.id, sr.periode_id, sr.aanvrager_person_id, sr.respondent_person_id, sr.status, sr.opmerkingen, sr.laatste_herinnering_op,
       sr.aangemaakt_op, os.datum AS aangeboden_datum, ot.teller AS aangeboden_teller, gs.datum AS gevraagd_datum, gt.teller AS gevraagd_teller,
       p.naam AS periode_naam, a.codenaam AS aanvrager, r.codenaam AS collega
  FROM dienstrooster_swap_request sr
  JOIN dienstrooster_schedule_period p ON p.id = sr.periode_id
  JOIN dienstrooster_person a ON a.id = sr.aanvrager_person_id
  JOIN dienstrooster_person r ON r.id = sr.respondent_person_id
  JOIN dienstrooster_shift_slot os ON os.id = sr.aangeboden_slot_id
  JOIN dienstrooster_shift_type ot ON ot.id = os.shift_type_id
  JOIN dienstrooster_shift_slot gs ON gs.id = sr.gevraagde_slot_id
  JOIN dienstrooster_shift_type gt ON gt.id = gs.shift_type_id`;

const DOOR_TEKST: Record<HerinneringDoor, string> = {
  AUTOMATISCH: 'Je verzoek stond al bijna 7 dagen open. Daarom is er automatisch een herinnering gestuurd.',
  AANVRAGER: 'Je hebt zelf een herinnering gestuurd.',
  PLANNER: 'De planner heeft een herinnering gestuurd.',
};

const HERINNERING_COLLEGA = {
  naam: 'SWAP_REMINDER_MAIL',
  onderwerp: 'Herinnering: een ruilverzoek wacht op jouw antwoord',
  tekst:
    'Beste {{codenaam}},\n\nEen collega wacht nog op je antwoord op een ruilverzoek met het volgende voorstel:\n\n{{details}}\n\n' +
    'Keur het verzoek goed of wijs het af.\n\n{{link}}',
};

const HERINNERING_AANVRAGER = {
  naam: 'SWAP_REMINDER_SENT_MAIL',
  onderwerp: 'Er is een herinnering gestuurd voor je ruilverzoek',
  tekst:
    'Beste {{codenaam}},\n\nEr is een herinnering gestuurd naar je collega voor je ruilverzoek. {{door}}\n\n{{details}}\n\n' +
    'Overweeg de dienst ook te ruilen met een andere dag of collega. Je mag meer dan één verzoek tegelijk doen. ' +
    'Zodra iemand de ruil accepteert, wordt het andere verzoek automatisch ingetrokken.\n\n{{link}}',
};

const shift = (datum: string, teller: string): SwapShift => ({ datum, teller });

/** The notices in the app and the mails, for one reminder. Call after the claim was written. */
function meld(r: RuilRij, door: HerinneringDoor): void {
  const aangeboden = shift(r.aangeboden_datum, r.aangeboden_teller);
  const gevraagd = shift(r.gevraagd_datum, r.gevraagd_teller);
  const voorCollega = swapMailDetails({ lezer: 'collega', aanvrager: r.aanvrager, collega: r.collega, aangeboden, gevraagd, toelichting: r.opmerkingen });
  const voorAanvrager = swapMailDetails({ lezer: 'aanvrager', aanvrager: r.aanvrager, collega: r.collega, aangeboden, gevraagd, toelichting: r.opmerkingen });
  db.transaction(() => {
    insertNotification({
      personId: r.respondent_person_id,
      periodId: r.periode_id,
      type: 'RUILVERZOEK',
      onderwerp: `Herinnering: het ruilverzoek van ${r.aanvrager} wacht op jouw antwoord`,
      inhoud: `Beste ${r.collega},\n\n${r.aanvrager} wacht nog op je antwoord op een ruilverzoek.\n\n${voorCollega}`,
    });
    insertNotification({
      personId: r.aanvrager_person_id,
      periodId: r.periode_id,
      type: 'RUILVERZOEK',
      onderwerp: 'Er is een herinnering gestuurd voor je ruilverzoek',
      inhoud: `Beste ${r.aanvrager},\n\nEr is een herinnering gestuurd naar ${r.collega} voor je ruilverzoek. ${DOOR_TEKST[door]}\n\n${voorAanvrager}`,
    });
  })();
  void mailMelding({
    swapId: r.id,
    personId: r.respondent_person_id,
    periodId: r.periode_id,
    template: HERINNERING_COLLEGA,
    placeholders: { codenaam: r.collega, details: voorCollega },
    anderen: [],
    soort: 'RUIL_HERINNERING',
    linkIntro: 'Bekijk het verzoek via je persoonlijke link:',
  });
  void mailMelding({
    swapId: r.id,
    personId: r.aanvrager_person_id,
    periodId: r.periode_id,
    template: HERINNERING_AANVRAGER,
    placeholders: { codenaam: r.aanvrager, door: DOOR_TEKST[door], details: voorAanvrager },
    anderen: [],
    soort: 'RUIL_HERINNERING_BEVESTIGING',
    linkIntro: 'Bekijk je ruilverzoeken via je persoonlijke link:',
  });
}

/** A shift still to come: a request about one that has been is no reason for a reminder. */
function inHetVerleden(r: RuilRij, now: Date): boolean {
  const pad = (n: number) => String(n).padStart(2, '0');
  const vandaag = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return r.aangeboden_datum < vandaag || r.gevraagd_datum < vandaag;
}

function definitief(periodId: string): boolean {
  const p = db
    .prepare('SELECT status, definitief_op FROM dienstrooster_schedule_period WHERE id = ? AND verwijderd_op IS NULL')
    .get(periodId) as { status: string; definitief_op: string | null } | undefined;
  return p?.status === 'GEPUBLICEERD' && Boolean(p.definitief_op);
}

export type HerinnerUitkomst =
  | { ok: true; id: string }
  | { ok: false; status: number; code: string; message: string; laatste_herinnering_op?: string | null };

const nee = (status: number, code: string, message: string, laatste?: string | null): HerinnerUitkomst => ({
  ok: false,
  status,
  code,
  message,
  ...(laatste !== undefined ? { laatste_herinnering_op: laatste } : {}),
});

/**
 * A reminder by hand. `door` AANVRAGER: only for the requester's own
 * request (`actorId`). The planner's access to the period is checked by the
 * route. Without `bevestigd` nothing is sent and the answer says when the
 * last reminder went (BEVESTIGING).
 */
export function herinnerRuil(
  swapId: string,
  door: 'AANVRAGER' | 'PLANNER',
  actorId: string,
  bevestigd: boolean,
  now: Date = new Date()
): HerinnerUitkomst {
  const r = db.prepare(`${SELECT} WHERE sr.id = ? AND p.verwijderd_op IS NULL`).get(swapId) as RuilRij | undefined;
  if (!r || (door === 'AANVRAGER' && r.aanvrager_person_id !== actorId)) return nee(404, 'NOT_FOUND', 'Ruilverzoek niet gevonden.');
  if (!definitief(r.periode_id)) {
    return nee(409, 'NOT_DEFINITIEF', 'Ruilen kan pas als het rooster definitief is. Klopt er iets niet in je voorlopige rooster? Meld dat bij de planner.');
  }
  if (r.status !== 'PENDING') return nee(409, 'HANDLED', 'Dit ruilverzoek is al afgehandeld. Er is geen herinnering meer nodig.');
  if (inHetVerleden(r, now)) return nee(409, 'IN_PAST', 'Een van de diensten is al geweest. Er is geen herinnering meer nodig.');
  if (r.laatste_herinnering_op && now.getTime() - Date.parse(r.laatste_herinnering_op) < HERINNERING_MIN_TUSSENTIJD_MS) {
    return nee(409, 'TOO_SOON', 'Er is de afgelopen 24 uur al een herinnering gestuurd. Probeer het later opnieuw.', r.laatste_herinnering_op);
  }
  if (!bevestigd) return nee(409, 'BEVESTIGING', 'Bevestig dat je een herinnering wilt sturen.', r.laatste_herinnering_op);
  db.prepare(`UPDATE dienstrooster_swap_request SET laatste_herinnering_op = ?, laatste_herinnering_door = ? WHERE id = ? AND status = 'PENDING'`).run(
    now.toISOString(),
    door,
    r.id
  );
  writeAuditLog({
    actorId,
    entiteit: 'swap_request',
    entiteitId: r.id,
    actie: 'UPDATE',
    oud: { laatste_herinnering_op: r.laatste_herinnering_op },
    nieuw: { herinnering: door, laatste_herinnering_op: now.toISOString() },
  });
  meld(r, door);
  return { ok: true, id: r.id };
}

/**
 * The automatic reminders: every open request on a definitief roster that
 * has been open 7 x 24 hours (rounded down to 09:00) and was not reminded
 * yet, by anyone. Run by the hourly check. Returns how many.
 */
export function stuurAutomatischeRuilHerinneringen(now: Date = new Date()): number {
  const rijen = db
    .prepare(
      `${SELECT} WHERE sr.status = 'PENDING' AND sr.laatste_herinnering_op IS NULL
         AND p.status = 'GEPUBLICEERD' AND p.definitief_op IS NOT NULL AND p.verwijderd_op IS NULL`
    )
    .all() as RuilRij[];
  let aantal = 0;
  for (const r of rijen) {
    if (now < ruilHerinneringMoment(r.aangemaakt_op) || inHetVerleden(r, now)) continue;
    const geclaimd = db
      .prepare(
        `UPDATE dienstrooster_swap_request SET laatste_herinnering_op = ?, laatste_herinnering_door = 'AUTOMATISCH'
         WHERE id = ? AND laatste_herinnering_op IS NULL AND status = 'PENDING'`
      )
      .run(now.toISOString(), r.id).changes;
    if (geclaimd !== 1) continue;
    writeAuditLog({ actorId: r.aanvrager_person_id, entiteit: 'swap_request', entiteitId: r.id, actie: 'UPDATE', nieuw: { herinnering: 'AUTOMATISCH' } });
    meld(r, 'AUTOMATISCH');
    aantal++;
  }
  return aantal;
}
