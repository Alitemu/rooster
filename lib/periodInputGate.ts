/**
 * Shared "may this person still change their input for this period" check
 *
 * Two independent reasons block a participant's preference-affecting
 * routes (slot toggles, part-time patterns, submission): the period has
 * moved past OPEN (planner closed it, generated the roster, ...), or -
 * regardless of status - its deadline has passed. The deadline is the one
 * a participant actually sees and plans around, so it has to be checked
 * directly against the clock, not inferred from whether the planner
 * happened to close the period exactly on time.
 */

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
 * Builds the Dutch warning shown when an absence/part-time pattern was
 * saved but overlaps one or more periods whose deadline has already
 * passed - those periods' sync silently excludes it (see
 * lib/parttimeSync.ts's findDeadlinePassedOverlappingPeriods), so without
 * this the participant has no way to tell that apart from "it worked".
 */
export function buildDeadlinePassedWarning(periods: Array<{ naam: string }>): string | undefined {
  if (periods.length === 0) return undefined;
  const namen = periods.map((p) => `"${p.naam}"`).join(', ');
  return periods.length === 1
    ? `Let op: voor periode ${namen} is de deadline al verstreken - dit is daar niet in verwerkt.`
    : `Let op: voor de periodes ${namen} is de deadline al verstreken - dit is daar niet in verwerkt.`;
}

export function checkPeriodAcceptsInput(period: PeriodForInputGate, now: Date = new Date()): InputGateResult {
  if (period.status !== 'OPEN') {
    return {
      allowed: false,
      code: 'PERIOD_NOT_OPEN',
      message: `Voorkeuren zijn alleen-lezen zodra de periode in status ${period.status} staat`,
    };
  }

  if (now > new Date(period.deadline)) {
    return {
      allowed: false,
      code: 'DEADLINE_PASSED',
      message: 'De deadline voor deze periode is verstreken - voorkeuren zijn nu alleen-lezen',
    };
  }

  return { allowed: true };
}
