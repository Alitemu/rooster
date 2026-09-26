/**
 * The active period: the one whose invitations went out most recently
 * (schedule_period.uitgenodigd_op, set by a successful invitation send).
 * Participants deal with one period at a time, so:
 *
 * - "Link kwijt?" on the start page links to it and nothing else
 *   (lib/linkAanvraag.ts);
 * - another period can only be invited once the active one's roster is
 *   published - at that point the new one takes over. Sending the active
 *   period's own invitations again is always allowed;
 * - the period list marks it "Actief".
 *
 * A period in the trash is never active.
 */

import { db } from '@/db/client';

export interface ActivePeriod {
  id: string;
  naam: string;
  status: string;
  deadline: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
}

export function getActivePeriod(): ActivePeriod | undefined {
  return db
    .prepare(
      `SELECT id, naam, status, deadline, pool_id, start_datum, eind_datum
       FROM dienstrooster_schedule_period
       WHERE uitgenodigd_op IS NOT NULL AND verwijderd_op IS NULL
       ORDER BY uitgenodigd_op DESC, aangemaakt_op DESC
       LIMIT 1`
    )
    .get() as ActivePeriod | undefined;
}

export type ActivationCheck = { allowed: true } | { allowed: false; code: 'OTHER_PERIOD_ACTIVE'; message: string };

/** May the invitations for this period go out now? */
export function checkMayBecomeActive(periodId: string): ActivationCheck {
  const active = getActivePeriod();
  if (!active || active.id === periodId || active.status === 'GEPUBLICEERD') return { allowed: true };
  return {
    allowed: false,
    code: 'OTHER_PERIOD_ACTIVE',
    message:
      `${active.naam} is nog de actieve periode. Uitnodigingen voor een andere periode kunnen pas ` +
      `als het rooster van ${active.naam} gepubliceerd is.`,
  };
}

export function markInvited(periodId: string, now: Date = new Date()): void {
  db.prepare('UPDATE dienstrooster_schedule_period SET uitgenodigd_op = ? WHERE id = ?').run(now.toISOString(), periodId);
}
