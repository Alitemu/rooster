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
