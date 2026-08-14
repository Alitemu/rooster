/**
 * Capacity checking utilities
 *
 * Two formulas from plan section 7.5:
 * 1. Total capacity: pool can generate enough shifts
 * 2. Distinct people per window: enough different people in each window
 *
 * Convention: negative delta = fewer shifts, positive = more shifts
 */

export interface CapacityCheckResult {
  totalCapacity: {
    passed: boolean;
    maxPerPerson: number;
    poolCapacity: number;
    slotsNeeded: number;
    message: string;
  };
  distinctPeople: {
    passed: boolean;
    required: number;
    available: number;
    windowWeeks: number;
    message: string;
  };
  overallPassed: boolean;
}

/**
 * Calculate total capacity check
 *
 * Formula:
 *   max_per_person = floor(num_weeks / windowWeeks)
 *   pool_capacity = active_participants * max_per_person
 *   Check: pool_capacity >= total_slots
 */
export function checkTotalCapacity(
  numWeeks: number,
  windowWeeks: number,
  activeParticipants: number,
  totalSlots: number
): CapacityCheckResult['totalCapacity'] {
  const maxPerPerson = Math.floor(numWeeks / windowWeeks);
  const poolCapacity = activeParticipants * maxPerPerson;
  const passed = poolCapacity >= totalSlots;

  let message = '';
  if (passed) {
    message = `Pool has sufficient capacity: ${poolCapacity} shifts available for ${totalSlots} needed.`;
  } else {
    const shortfall = totalSlots - poolCapacity;
    message = `Pool lacks capacity: only ${poolCapacity} shifts available but ${totalSlots} needed (${shortfall} short).`;
  }

  return {
    passed,
    maxPerPerson,
    poolCapacity,
    slotsNeeded: totalSlots,
    message,
  };
}

/**
 * Calculate distinct people per window check
 *
 * Formula:
 *   required = 7 * windowWeeks
 *   Check: active_participants >= required
 *
 * This is typically more restrictive than total capacity!
 * With 7 slots per week, you need 7 distinct people per window.
 */
export function checkDistinctPeople(
  windowWeeks: number,
  activeParticipants: number
): CapacityCheckResult['distinctPeople'] {
  const required = 7 * windowWeeks;
  const passed = activeParticipants >= required;

  let message = '';
  if (passed) {
    message = `Enough distinct people: ${activeParticipants} available for required ${required}.`;
  } else {
    const shortfall = required - activeParticipants;
    message = `Not enough distinct people: only ${activeParticipants} but ${required} required (${shortfall} short).`;
  }

  return {
    passed,
    required,
    available: activeParticipants,
    windowWeeks,
    message,
  };
}

/**
 * Run both capacity checks
 */
export function checkCapacity(
  numWeeks: number,
  windowWeeks: number,
  activeParticipants: number,
  totalSlots: number
): CapacityCheckResult {
  const totalCapacity = checkTotalCapacity(numWeeks, windowWeeks, activeParticipants, totalSlots);
  const distinctPeople = checkDistinctPeople(windowWeeks, activeParticipants);

  return {
    totalCapacity,
    distinctPeople,
    overallPassed: totalCapacity.passed && distinctPeople.passed,
  };
}

/**
 * Get human-readable interpretation of capacity
 * Used in UI to explain constraints
 */
export function getCapacityInterpretation(windowWeeks: number, slots: number, people: number): string {
  const distinctRequired = 7 * windowWeeks;

  const lines = [
    `With a window of ${windowWeeks} weeks:`,
    `- You need at least ${distinctRequired} different people to cover all weeks`,
    `- Each person can do at most ${Math.floor(slots / Math.max(people, 1))} shifts`,
  ];

  if (people < distinctRequired) {
    lines.push(`⚠️ NOT ENOUGH: You have ${people} people but need ${distinctRequired}`);
  } else {
    lines.push(`✓ SUFFICIENT: ${people} people available`);
  }

  return lines.join('\n');
}

/**
 * Get the maximum number of active participants allowed with current settings
 * (Useful for showing "you can remove down to X people")
 */
export function getMinimumParticipantsNeeded(windowWeeks: number): number {
  return 7 * windowWeeks;
}

/**
 * Get the window weeks needed to support a given number of participants
 * (Useful for suggesting "if you increase window to X weeks, you can support Y people")
 */
export function getMaxWindowWeeksForParticipants(participants: number): number {
  return Math.floor(participants / 7);
}

/**
 * Calculate periods-to-fair-distribution for a person with a balance
 * Used to estimate when a person will "catch up" if they consistently
 * receive their fair share each period
 *
 * Example: Person has balance -2 and fair share is 8
 * If they receive 8 shifts next period, they stay at -2
 * If they receive 10 shifts, they go to 0
 */
export function periodsToCatchUp(
  currentBalance: number,
  fairShareMax: number
): number | null {
  if (currentBalance >= 0) {
    return 0; // Already caught up
  }

  // Best case: they get max of fair share each period
  const shiftsNeeded = Math.abs(currentBalance);
  const shiftsPerPeriod = fairShareMax;

  if (shiftsPerPeriod <= 0) {
    return null; // Can't catch up
  }

  return Math.ceil(shiftsNeeded / shiftsPerPeriod);
}
