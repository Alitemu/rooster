/**
 * How many swap requests one participant may start per 24 hours.
 *
 * Every request mails two people and withdrawing one mails a third
 * (lib/meldingMail.ts, lib/swapLifecycle.ts). Refusing the exact same
 * request twice (the create route) does not bound that: other shift
 * combinations, or withdrawing and asking again, each count as new. Left
 * open, one participant, or anyone holding their personal link, could flood
 * a colleague's inbox and use up the sending account's daily limit (about
 * 500 mails at Gmail), after which invitations and reminders fail too.
 *
 * Counted from the swap_request rows themselves, withdrawn ones included,
 * so it survives a restart and a withdraw-and-ask-again loop counts every
 * round. Twenty is far above what offering a shift to several colleagues
 * needs, and caps one participant at about sixty mails a day.
 */

import { db } from '@/db/client';

export const MAX_RUILVERZOEKEN_PER_DAG = 20;

export const RUILVERZOEK_LIMIET_MELDING =
  `Je hebt de afgelopen 24 uur al ${MAX_RUILVERZOEKEN_PER_DAG} ruilverzoeken gedaan. ` +
  'Wacht tot morgen of vraag de planner om hulp.';

export function swapQuotaReached(personId: string, now: Date = new Date()): boolean {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM dienstrooster_swap_request
       WHERE aanvrager_person_id = ? AND aangemaakt_op > ?`
    )
    .get(personId, since) as { n: number };
  return n >= MAX_RUILVERZOEKEN_PER_DAG;
}
