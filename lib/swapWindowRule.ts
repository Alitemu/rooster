/**
 * Does a swap leave either participant violating the window rule?
 *
 * The window rule ("no second shift within N weeks of one you already
 * have") is a hard constraint for the solver. lib/windowRule.ts is
 * deliberately informational instead, because a planner filling a gap by
 * hand must be able to override it in consultation with the person taking
 * the shift.
 *
 * A participant-to-participant swap is neither of those. No planner is in
 * the loop and nobody is consulted, so an approved swap could quietly put
 * someone two shifts in the same week and leave the published roster
 * violating the one rule the solver is not allowed to break - with nothing
 * anywhere reporting it. This check closes that: the swap is refused, and
 * the message points at the planner, the same way an unequal (cross-teller)
 * trade already does.
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

export interface SwapWindowResult {
  allowed: boolean;
  message?: string;
}

interface SlotRow {
  iso_jaar: number;
  iso_week: number;
  teller: string;
}

export function checkSwapWindowRule(sides: SwapSides): SwapWindowResult {
  const period = db
    .prepare(
      `SELECT id, pool_id, bevroren_ruleset_json
       FROM dienstrooster_schedule_period WHERE id = ?`
    )
    .get(sides.periodId) as
    | { id: string; pool_id: string; bevroren_ruleset_json: string | null }
    | undefined;
  if (!period) return { allowed: true };

  const windows = resolveWindowWeeks(resolveRulesetConfig(period));

  const slotStmt = db.prepare(
    `SELECT s.iso_jaar, s.iso_week, st.teller
     FROM dienstrooster_shift_slot s
     JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
     WHERE s.id = ?`
  );
  const offered = slotStmt.get(sides.offeredSlotId) as SlotRow | undefined;
  const requested = slotStmt.get(sides.requestedSlotId) as SlotRow | undefined;
  if (!offered || !requested) return { allowed: true };

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

  if (!requesterConflicts && !respondentConflicts) return { allowed: true };

  return {
    allowed: false,
    message:
      'Door deze ruil zou iemand twee diensten te kort op elkaar krijgen. ' +
      'Vraag de planner om deze ruil handmatig te verwerken.',
  };
}
