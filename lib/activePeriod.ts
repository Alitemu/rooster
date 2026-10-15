/**
 * The active period of a pool: the one whose invitations went out most
 * recently (schedule_period.uitgenodigd_op, set by a successful invitation
 * send). A pool's participants deal with one period at a time, so:
 *
 * - "Link kwijt?" on the start page links to it and nothing else
 *   (lib/linkAanvraag.ts), for every pool;
 * - another period of the pool can only be invited once the active one's
 *   roster is published - at that point the new one takes over. Sending
 *   the active period's own invitations again is always allowed;
 * - the period list marks it "Actief".
 *
 * Per pool, not for the whole app: the achterwacht and the AIOS each have
 * their own (lib/dienstAccess.ts). One for the app kept the AIOS planner
 * from inviting while the achterwacht's period was open, and the refusal
 * named that period.
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

const LATEST_INVITED = `
  SELECT id, naam, status, deadline, pool_id, start_datum, eind_datum
  FROM dienstrooster_schedule_period
  WHERE pool_id = ? AND uitgenodigd_op IS NOT NULL AND verwijderd_op IS NULL
  ORDER BY uitgenodigd_op DESC, aangemaakt_op DESC
  LIMIT 1`;

export function getActivePeriod(poolId: string): ActivePeriod | undefined {
  return db.prepare(LATEST_INVITED).get(poolId) as ActivePeriod | undefined;
}

/** The active period of every pool that has one. */
export function getActivePeriods(): ActivePeriod[] {
  const pools = db.prepare('SELECT id FROM dienstrooster_pool ORDER BY naam').all() as Array<{ id: string }>;
  return pools.map((p) => getActivePeriod(p.id)).filter((p): p is ActivePeriod => p !== undefined);
}

export type ActivationCheck = { allowed: true } | { allowed: false; code: 'OTHER_PERIOD_ACTIVE'; message: string };

/** May the invitations for this period go out now? */
export function checkMayBecomeActive(periodId: string): ActivationCheck {
  const period = db.prepare('SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as
    | { pool_id: string }
    | undefined;
  const active = period ? getActivePeriod(period.pool_id) : undefined;
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
