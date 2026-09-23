/**
 * Would a swap leave either participant with two shifts close together?
 *
 * The window rule ("no second shift within N weeks of one you already
 * have") is a hard constraint for the solver. A swap is different: two
 * participants agree between themselves, and someone who wants two shifts
 * in one week is allowed to decide that for themselves - it is not the
 * planner's call. So this only reports it: the swap dialog groups such a
 * colleague separately and warns the requester, and the colleague sees a
 * warning with the request before approving. Nothing refuses it.
 *
 * Once approved, a violation like that is flagged as a warning by the
 * publication check (lib/publicationCheck.ts) - which is just a heads-up
 * for a planner who unpublishes and republishes, not a block.
 */

import { db } from '@/db/client';
import { personWouldViolateWindowRule } from './windowRule';
import { resolveRulesetConfig, resolveWindowWeeks } from './rosterBands';

interface SwapSides {
  periodId: string;
  requesterPersonId: string;
  respondentPersonId: string;
  offeredSlotId: string;
  requestedSlotId: string;
}

export interface SwapWindowConflicts {
  /** The requester would end up with the requested shift close to another shift of theirs. */
  requesterTooClose: boolean;
  /** The respondent would end up with the offered shift close to another shift of theirs. */
  respondentTooClose: boolean;
}

interface SlotRow {
  iso_jaar: number;
  iso_week: number;
  teller: string;
}

export function swapWindowConflicts(sides: SwapSides): SwapWindowConflicts {
  const period = db
    .prepare(
      `SELECT id, pool_id, bevroren_ruleset_json
       FROM dienstrooster_schedule_period WHERE id = ?`
    )
    .get(sides.periodId) as
    | { id: string; pool_id: string; bevroren_ruleset_json: string | null }
    | undefined;
  if (!period) return { requesterTooClose: false, respondentTooClose: false };

  const windows = resolveWindowWeeks(resolveRulesetConfig(period));

  const slotStmt = db.prepare(
    `SELECT s.iso_jaar, s.iso_week, st.teller
     FROM dienstrooster_shift_slot s
     JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
     WHERE s.id = ?`
  );
  const offered = slotStmt.get(sides.offeredSlotId) as SlotRow | undefined;
  const requested = slotStmt.get(sides.requestedSlotId) as SlotRow | undefined;
  if (!offered || !requested) return { requesterTooClose: false, respondentTooClose: false };

  // Each person is checked against the slot they would receive, with the
  // slot they are giving up excluded - otherwise the shift they are about
  // to hand over would count as a conflict against itself.
  const requesterConflicts = personWouldViolateWindowRule(
    sides.periodId,
    sides.requesterPersonId,
    requested.iso_jaar,
    requested.iso_week,
    requested.teller,
    windows,
    sides.offeredSlotId
  );

  const respondentConflicts = personWouldViolateWindowRule(
    sides.periodId,
    sides.respondentPersonId,
    offered.iso_jaar,
    offered.iso_week,
    offered.teller,
    windows,
    sides.requestedSlotId
  );

  return { requesterTooClose: requesterConflicts, respondentTooClose: respondentConflicts };
}
