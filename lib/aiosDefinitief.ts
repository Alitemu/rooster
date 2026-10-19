/**
 * Whether the roster of an AIOS quarter is definitief. A voorlopig roster
 * (published, the AIOS check it and swap) goes nowhere outside the planner's
 * own page: what the roosterbureau gets, its Excel and the messages about
 * swaps, only comes once the roster is definitief.
 */

import { db } from '@/db/client';

export function aiosIsDefinitief(periodId: string): boolean {
  const rij = db.prepare('SELECT status, definitief_op FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as
    | { status: string; definitief_op: string | null }
    | undefined;
  return rij?.status === 'GEPUBLICEERD' && rij.definitief_op !== null;
}

/** What the roosterbureau's Excel and the planner's page say while it is not. */
export const NOG_NIET_DEFINITIEF =
  'Het rooster is nog niet definitief. Het roosterbureau krijgt alleen een definitief rooster. Maak het rooster eerst definitief.';
