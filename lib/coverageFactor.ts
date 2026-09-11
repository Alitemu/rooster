/**
 * Coverage factor: how much of a period a pool membership actually spans.
 *
 * Someone who joins or leaves mid-period still gets selected by the
 * membership-overlap query (geldig_vanaf <= period end AND geldig_tot >=
 * period start), but without this they'd get the exact same band target as
 * a full-time member who covers the whole period. This is a structural
 * fact about the membership window, not a fairness policy - unlike
 * `deelnamefactor` (manually set, only applied under Verdeelmodus =
 * "Naar rato"), coverage always applies and is never merged into
 * `deelnamefactor` itself, to avoid a planner "double-correcting" by also
 * lowering deelnamefactor.
 *
 * Pure function, no `db` import - safe to use from both server routes
 * (solver input, publication check) and 'use client' components (the
 * SetupWizard notice), so all three can never disagree about the
 * percentage.
 */

import { parseISO } from './holidays';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function inclusiveDayCount(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / ONE_DAY_MS) + 1;
}

/**
 * Fraction of the period [periodStart, periodEnd] covered by the membership
 * window [membershipStart, membershipEnd], clamped to [0, 1].
 *
 * Dates are ISO-8601 strings (YYYY-MM-DD); string comparison is enough to
 * clamp the window since ISO dates sort lexicographically.
 */
export function computeCoverageFactor(
  membershipStart: string,
  membershipEnd: string,
  periodStart: string,
  periodEnd: string
): number {
  const overlapStart = membershipStart > periodStart ? membershipStart : periodStart;
  const overlapEnd = membershipEnd < periodEnd ? membershipEnd : periodEnd;

  const periodDays = inclusiveDayCount(parseISO(periodStart), parseISO(periodEnd));
  if (periodDays <= 0) return 1;

  if (overlapStart > overlapEnd) return 0;

  const overlapDays = inclusiveDayCount(parseISO(overlapStart), parseISO(overlapEnd));
  const factor = overlapDays / periodDays;

  return Math.max(0, Math.min(1, factor));
}
