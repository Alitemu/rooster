/**
 * Window rule conflict detection - informational only.
 *
 * The window rule is a hard constraint for the solver (solver/constraints.py,
 * solver/greedy.py) but a deliberate non-blocker for manual assignment: a
 * planner filling a gap or swapping a shift by hand must always be able to
 * override it, in consultation with the person taking the shift (see
 * lib/rosterGaps.ts). This module exists purely to surface that a candidate
 * would violate the window rule - grouped in the manual-assign candidate
 * menu and named in the post-assignment warning - never to block anything.
 *
 * A window of N weeks keeps at least 7 * N days between two shifts of one
 * person (0.22.0), counted between the shifts' own dates. It counted
 * calendar weeks - one shift in any N consecutive Monday-to-Sunday weeks -
 * so a Sunday and the Monday two weeks later, 8 days apart, passed a
 * window of 2, where the planner read it as 14 days. Dates subtract the
 * same across a year boundary (ISO week 53) as anywhere else.
 *
 * Per-teller windows: AVOND and WEEKEND+FEESTDAG each have their own
 * (typically larger) same-type cap, but the *smaller* of the two also
 * applies as a floor between every pair of shifts regardless of type -
 * "een weekenddienst kan wel een avonddienst blokkeren en andersom... het
 * minimum geldt dan voor alle diensten". See requiredGapWeeks below, and
 * solver/constraints.py's add_window_constraints for the CP-SAT
 * counterpart this mirrors exactly.
 */

import { db } from '@/db/client';
import { countWeeksBetween } from './holidays';
import type { WindowWeeksConfig } from './rosterBands';

/** Days between two YYYY-MM-DD dates, whichever comes first. */
export function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Whether two shifts sit closer than a window of `weeks` allows: fewer than 7 * weeks days apart. */
export function tooClose(a: string, b: string, weeks: number): boolean {
  return weeks > 0 && daysApart(a, b) < 7 * weeks;
}

/** Calendar weeks between two ISO (year, week) pairs; 0 if the same week. */
export function isoWeeksApart(y1: number, w1: number, y2: number, w2: number): number {
  if (y1 === y2 && w1 === w2) return 0;
  const [minY, minW, maxY, maxW] =
    y1 < y2 || (y1 === y2 && w1 < w2) ? [y1, w1, y2, w2] : [y2, w2, y1, w1];
  return countWeeksBetween(minY, minW, maxY, maxW) - 1;
}

const windowGroup = (teller: string): 'avond' | 'weekend_feestdag' =>
  teller === 'AVOND' ? 'avond' : 'weekend_feestdag';

/**
 * The minimum gap (in weeks) required between a shift of `tellerA` and one
 * of `tellerB` for the same person, under per-teller windows - same
 * teller (both AVOND, or both WEEKEND/FEESTDAG): that group's own window;
 * different tellers: the smaller of the two windows (the cross-type
 * floor). A period with only the legacy pooled windowWeeks resolves to
 * `windows.avond === windows.weekendFeestdag` (see
 * lib/rosterBands.ts's resolveWindowWeeks), which collapses this to that
 * one shared value regardless of teller - reproducing the old pooled
 * behaviour exactly, not a special case to branch on separately.
 */
export function requiredGapWeeks(tellerA: string, tellerB: string, windows: WindowWeeksConfig): number {
  if (windowGroup(tellerA) === windowGroup(tellerB)) {
    return tellerA === 'AVOND' ? windows.avond : windows.weekendFeestdag;
  }
  return Math.min(windows.avond, windows.weekendFeestdag);
}

/**
 * The shifts a warning about `periodId` weighs, for one person or for
 * everyone (audit 11): the period's own, the person's shifts in the
 * pool's other periods outside the prullenbak - a generated or published
 * roster, or a shift filled in by hand beforehand in one still being
 * made (a SOLVER row of a period waiting to be generated again is no
 * roster) - and the period's own "Eerdere toewijzingen", which carry
 * history from before the app. The solver and the publication check
 * already looked across the boundary; the warnings while filling, moving
 * or swapping a shift looked inside the period only, so someone who
 * worked the last Sunday before it was offered for the Monday after
 * without a word. Only the years around the target matter for a window
 * of at most 52 weeks (lib/rulesetValidation.ts), so only those are read.
 */
function shiftsAround(
  periodId: string,
  targetDatum: string,
  personId: string | null,
  excludeSlotId?: string
): Array<{ person_id: string; datum: string; teller: string }> {
  const personClause = personId ? 'AND a.person_id = @person' : '';
  const year = Number(targetDatum.slice(0, 4));
  return db
    .prepare(
      `SELECT a.person_id, s.datum, st.teller
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = @period ${personClause}
         ${excludeSlotId ? 'AND a.slot_id != @exclude' : ''}
       UNION ALL
       SELECT a.person_id, s.datum, st.teller
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       JOIN dienstrooster_schedule_period sp ON sp.id = s.period_id
       WHERE sp.pool_id = (SELECT pool_id FROM dienstrooster_schedule_period WHERE id = @period)
         AND sp.id != @period AND sp.verwijderd_op IS NULL
         AND (sp.status IN ('GEGENEREERD', 'GEPUBLICEERD') OR a.bron IN ('MANUAL', 'OVERRIDE'))
         AND s.datum BETWEEN @from AND @to ${personClause}
       UNION ALL
       SELECT pa.person_id, pa.datum, pa.teller
       FROM dienstrooster_prior_assignment pa
       WHERE pa.period_id = @period AND pa.person_id IS NOT NULL
         ${personId ? 'AND pa.person_id = @person' : ''}`
    )
    .all({
      period: periodId,
      from: `${year - 1}-01-01`,
      to: `${year + 1}-12-31`,
      ...(personId ? { person: personId } : {}),
      ...(excludeSlotId ? { exclude: excludeSlotId } : {}),
    }) as Array<{ person_id: string; datum: string; teller: string }>;
}

/**
 * True if `personId` already has a shift (shiftsAround: this period, the
 * pool's other periods, "Eerdere toewijzingen") that sits too close (per
 * requiredGapWeeks, in days) to a shift of `targetTeller` on `targetDatum`.
 */
export function personWouldViolateWindowRule(
  periodId: string,
  personId: string,
  targetDatum: string,
  targetTeller: string,
  windows: WindowWeeksConfig,
  excludeSlotId?: string
): boolean {
  if (windows.avond <= 0 && windows.weekendFeestdag <= 0) return false;

  const rows = shiftsAround(periodId, targetDatum, personId, excludeSlotId);

  return rows.some((r) => tooClose(r.datum, targetDatum, requiredGapWeeks(targetTeller, r.teller, windows)));
}

interface TimedShift {
  datum: string;
  teller: string;
}

/**
 * Count actual window-rule violations already sitting in a period's
 * roster - not "would this violate", but "does this".
 *
 * The solver never produces one (it's a hard constraint), so a violation
 * here can only come from a deliberate manual override: a planner's manual
 * assign, which lib/windowRule.ts's own module doc says must always be
 * allowed to override this rule, in consultation with the person taking
 * the shift. That is why lib/publicationCheck.ts treats this as a warning
 * to confirm before publishing rather than a hard block - the override
 * already happened, deliberately, at manual-assign time; the gate's job is
 * to make sure a planner sees it once more before it goes out, not to
 * undo it.
 *
 * Also weighs in the previous period's carried-over tail
 * (dienstrooster_prior_assignment), the same history the solver itself
 * sees - otherwise a shift right after one at the very end of the last
 * period would look clean here despite being exactly what the window rule
 * exists to catch. A pair where both shifts are prior-period history is
 * not counted: that pair was already someone else's roster to get right,
 * not a violation this period's publication introduces.
 */
export function countWindowRuleViolations(periodId: string, windows: WindowWeeksConfig): number {
  if (windows.avond <= 0 && windows.weekendFeestdag <= 0) return 0;

  const current = db
    .prepare(
      `SELECT a.person_id, s.datum, st.teller
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = ?`
    )
    .all(periodId) as Array<{ person_id: string } & TimedShift>;

  const prior = db
    .prepare(
      `SELECT person_id, datum, teller
       FROM dienstrooster_prior_assignment
       WHERE period_id = ? AND person_id IS NOT NULL`
    )
    .all(periodId) as Array<{ person_id: string } & TimedShift>;

  const byPerson = new Map<string, Array<TimedShift & { isCurrent: boolean }>>();
  for (const row of current) {
    if (!byPerson.has(row.person_id)) byPerson.set(row.person_id, []);
    byPerson.get(row.person_id)!.push({ ...row, isCurrent: true });
  }
  for (const row of prior) {
    if (!byPerson.has(row.person_id)) byPerson.set(row.person_id, []);
    byPerson.get(row.person_id)!.push({ ...row, isCurrent: false });
  }

  let violations = 0;
  for (const shifts of byPerson.values()) {
    for (let i = 0; i < shifts.length; i++) {
      for (let j = i + 1; j < shifts.length; j++) {
        const a = shifts[i];
        const b = shifts[j];
        if (!a.isCurrent && !b.isCurrent) continue; // both history - not this roster's doing
        if (tooClose(a.datum, b.datum, requiredGapWeeks(a.teller, b.teller, windows))) {
          violations++;
        }
      }
    }
  }
  return violations;
}

/**
 * Person ids that already have a shift (shiftsAround) too close (per
 * requiredGapWeeks, in days) to a shift of `targetTeller` on `targetDatum`
 * - i.e. who would violate the window rule if assigned to that slot. Used
 * to categorise a candidate list in one query instead of calling
 * personWouldViolateWindowRule per person.
 */
export function getWindowConflictingPersonIds(
  periodId: string,
  targetDatum: string,
  targetTeller: string,
  windows: WindowWeeksConfig,
  excludeSlotId?: string
): Set<string> {
  if (windows.avond <= 0 && windows.weekendFeestdag <= 0) return new Set();

  const rows = shiftsAround(periodId, targetDatum, null, excludeSlotId);

  const conflicting = new Set<string>();
  for (const row of rows) {
    if (tooClose(row.datum, targetDatum, requiredGapWeeks(targetTeller, row.teller, windows))) {
      conflicting.add(row.person_id);
    }
  }
  return conflicting;
}
