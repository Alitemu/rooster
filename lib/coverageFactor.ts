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

/** Days of [periodStart, periodEnd] inside [membershipStart, membershipEnd], both ends included. */
function overlapDayCount(membershipStart: string, membershipEnd: string, periodStart: string, periodEnd: string): number {
  const overlapStart = membershipStart > periodStart ? membershipStart : periodStart;
  const overlapEnd = membershipEnd < periodEnd ? membershipEnd : periodEnd;
  if (overlapStart > overlapEnd) return 0;
  return inclusiveDayCount(parseISO(overlapStart), parseISO(overlapEnd));
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
  return combinedMembership([{ geldig_vanaf: membershipStart, geldig_tot: membershipEnd, deelnamefactor: 1 }], periodStart, periodEnd)
    .dekking;
}

/**
 * A person's part in one period over all their memberships in it - someone
 * who stopped and came back within the period has two, which never overlap
 * (the membership routes refuse that). Coverage is the days of all of them
 * together over the period's days; the deelnamefactor is weighted by those
 * days. Counting one of the memberships only gave someone present the
 * whole period the streefbereik of a part of it (audit 7).
 *
 * Summed in whole days and divided once, so one membership comes out
 * exactly as computeCoverageFactor always did, and a factor all of them
 * share is kept as it is.
 */
export function combinedMembership(
  memberships: Array<{ geldig_vanaf: string; geldig_tot: string; deelnamefactor: number | null }>,
  periodStart: string,
  periodEnd: string
): { dekking: number; deelnamefactor: number } {
  const periodDays = inclusiveDayCount(parseISO(periodStart), parseISO(periodEnd));
  let days = 0;
  let weighted = 0;
  for (const m of memberships) {
    const d = overlapDayCount(m.geldig_vanaf, m.geldig_tot, periodStart, periodEnd);
    days += d;
    weighted += d * (m.deelnamefactor ?? 1);
  }
  const factors = new Set(memberships.map((m) => m.deelnamefactor ?? 1));
  const deelnamefactor =
    factors.size <= 1 ? (memberships[0]?.deelnamefactor ?? 1) : days > 0 ? weighted / days : (memberships[memberships.length - 1].deelnamefactor ?? 1);
  const dekking = periodDays <= 0 ? 1 : Math.max(0, Math.min(1, days / periodDays));
  return { dekking, deelnamefactor };
}
