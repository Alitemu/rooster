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
 *
 * effectiveParticipants overrides the headcount used for the pool_capacity
 * multiplication only (activeParticipants keeps being reported as-is, and
 * still drives checkDistinctPeople separately - a part-timer still counts
 * as one distinct person available to cover a window). Pass the sum of
 * everyone's deelnamefactor here under NAAR_RATO, where each person's
 * actual max is scaled by their participation factor rather than everyone
 * counting as a full head - otherwise this check can say "capacity OK"
 * while the solver (which does scale per person, see
 * constraints.add_band_constraints) ends up short.
 */
export function checkTotalCapacity(
  numWeeks: number,
  windowWeeks: number,
  activeParticipants: number,
  totalSlots: number,
  effectiveParticipants: number = activeParticipants
): CapacityCheckResult['totalCapacity'] {
  const maxPerPerson = Math.floor(numWeeks / windowWeeks);
  const poolCapacity = Math.floor(effectiveParticipants * maxPerPerson);
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
  totalSlots: number,
  effectiveParticipants: number = activeParticipants
): CapacityCheckResult {
  const totalCapacity = checkTotalCapacity(numWeeks, windowWeeks, activeParticipants, totalSlots, effectiveParticipants);
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
    `Bij een venster van ${windowWeeks} weken:`,
    `- zijn minimaal ${distinctRequired} verschillende mensen nodig om alle weken te dekken`,
    `- kan iemand maximaal ${Math.floor(slots / Math.max(people, 1))} diensten draaien`,
  ];

  if (people < distinctRequired) {
    lines.push(`✗ Onvoldoende: er zijn ${people} mensen, maar ${distinctRequired} nodig`);
  } else {
    lines.push(`✓ Voldoende: ${people} mensen beschikbaar`);
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
