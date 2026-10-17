/**
 * Whether an AIOS may still change their input for a quarter: the period is
 * OPEN and its deadline has not passed. A copy of lib/periodInputGate.ts,
 * not an import of it (docs/development/diensten.md, "Copied, not
 * changed"): the AIOS's deadline rules stay theirs when the achterwacht's
 * change.
 *
 * The deadline is checked against the clock, whatever the status says: it
 * is the one the AIOS sees and plans around.
 */

import { periodStatusLabel } from '@/lib/aiosTeksten';

export interface PeriodForInputGate {
  status: string;
  deadline: string;
}

export interface InputGateResult {
  allowed: boolean;
  code?: 'PERIOD_NOT_OPEN' | 'DEADLINE_PASSED';
  message?: string;
}

/**
 * The warning when leave or a part-time day was saved but overlaps periods
 * past their deadline: the sync leaves those alone (lib/aiosSync.ts), and
 * without this it looks as if it worked.
 */
export function buildDeadlinePassedWarning(periods: Array<{ naam: string }>): string | undefined {
  if (periods.length === 0) return undefined;
  const namen = periods.map((p) => `"${p.naam}"`).join(', ');
  return periods.length === 1
    ? `Let op: voor periode ${namen} is de deadline al verstreken. Daar is dit niet in verwerkt.`
    : `Let op: voor de periodes ${namen} is de deadline al verstreken. Daar is dit niet in verwerkt.`;
}

/**
 * Whether a deadline has passed. A deadline is stored as the planner's
 * datetime-local input sent it (no timezone, "2027-01-15T17:00"), which
 * `new Date()` reads as local time: the ward's clock, pinned via TZ in
 * docker-compose.yml. Never compare it as text with an ISO timestamp, which
 * treats it as UTC.
 */
export function deadlinePassed(deadline: string, now: Date = new Date()): boolean {
  return now > new Date(deadline);
}

export function checkPeriodAcceptsInput(period: PeriodForInputGate, now: Date = new Date()): InputGateResult {
  if (period.status !== 'OPEN') {
    return {
      allowed: false,
      code: 'PERIOD_NOT_OPEN',
      message: `Voorkeuren zijn alleen-lezen zodra de periode de status "${periodStatusLabel(period.status)}" heeft`,
    };
  }

  if (deadlinePassed(period.deadline, now)) {
    return {
      allowed: false,
      code: 'DEADLINE_PASSED',
      message: 'De deadline voor deze periode is verstreken. Voorkeuren kun je nu alleen nog bekijken.',
    };
  }

  return { allowed: true };
}
