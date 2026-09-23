/**
 * When may reminders go out?
 *
 * Only while the period is open and its deadline hasn't passed. A reminder
 * says "hand in your preferences before <deadline>": after that moment the
 * date in it is wrong and the form is read-only anyway, so the planner
 * first moves the deadline (PATCH /api/periods/[id]/deadline, only possible
 * while OPEN) and the reminders are then generated with the new one.
 *
 * Also used to refuse a send whose text was generated for a deadline that
 * has since changed: the date in it would be the old one.
 */

import { deadlinePassed } from './periodInputGate';

export type ReminderGateResult =
  | { allowed: true }
  | { allowed: false; code: 'PERIOD_NOT_OPEN' | 'DEADLINE_PASSED' | 'DEADLINE_CHANGED'; message: string };

export function checkRemindersAllowed(
  period: { status: string; deadline: string },
  opts: { generatedFor?: string } = {},
  now: Date = new Date()
): ReminderGateResult {
  if (period.status !== 'OPEN') {
    return {
      allowed: false,
      code: 'PERIOD_NOT_OPEN',
      message: 'Herinneringen kunnen alleen verstuurd worden zolang de periode open staat voor voorkeuren.',
    };
  }
  if (deadlinePassed(period.deadline, now)) {
    return {
      allowed: false,
      code: 'DEADLINE_PASSED',
      message: 'De deadline is al voorbij. Pas eerst de deadline aan en genereer de herinneringen daarna opnieuw.',
    };
  }
  if (opts.generatedFor !== undefined && opts.generatedFor !== period.deadline) {
    return {
      allowed: false,
      code: 'DEADLINE_CHANGED',
      message:
        'De deadline is intussen gewijzigd. Genereer de herinneringen opnieuw, zodat de nieuwe deadline in de tekst staat.',
    };
  }
  return { allowed: true };
}

/**
 * Invitations name the deadline just the same ("uiterlijk ..."), and a
 * participant can only fill in preferences while the period is open, so
 * they go out under the same two conditions. (The CSV of links is not
 * gated: a link also opens the published roster later on.)
 */
export function checkInvitationsAllowed(
  period: { status: string; deadline: string },
  now: Date = new Date()
): ReminderGateResult {
  if (period.status !== 'OPEN') {
    return {
      allowed: false,
      code: 'PERIOD_NOT_OPEN',
      message: 'Uitnodigingen kunnen alleen verstuurd worden zolang de periode open staat voor voorkeuren.',
    };
  }
  if (deadlinePassed(period.deadline, now)) {
    return {
      allowed: false,
      code: 'DEADLINE_PASSED',
      message: 'De deadline is al voorbij. Pas eerst de deadline aan en verstuur de uitnodigingen daarna.',
    };
  }
  return { allowed: true };
}
