/**
 * Roster gaps and regeneration safety.
 *
 * Capacity is a soft constraint in the solver (see solver/constraints.py),
 * so a generated roster can come back with shifts nobody was assigned to.
 * The planner fills those in by hand, in consultation with whoever is
 * available - which means regeneration afterwards must not quietly undo
 * that work.
 *
 * Extracted from the routes so the invariants are testable against a real
 * database rather than only through a running server.
 */

import { db } from '@/db/client';
import { resolveRulesetConfig } from '@/lib/rosterBands';
import { getWindowConflictingPersonIds } from '@/lib/windowRule';

export interface EligiblePerson {
  id: string;
  codenaam: string;
}

export interface UnfilledSlot {
  slot_id: string;
  datum: string;
  iso_week: number;
  teller: string;
  benodigd_aantal_personen: number;
  assigned_count: number;
  shortfall: number;
  eligible_people: EligiblePerson[];
}

/**
 * Slots a planner already filled by hand.
 *
 * dienstrooster_assignment has UNIQUE(schedule_version_id, slot_id), so
 * re-solving without excluding these would either collide on insert or
 * overwrite the planner's decision.
 */
export function getManuallyFilledSlotIds(periodId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT slot_id FROM dienstrooster_assignment
       WHERE schedule_version_id = ? AND bron IN ('MANUAL', 'OVERRIDE')`
    )
    .all(periodId) as Array<{ slot_id: string }>;
  return new Set(rows.map((r) => r.slot_id));
}

/**
 * Drop the previous solver attempt so a regenerate replaces it.
 * Deliberately scoped to bron='SOLVER': MANUAL/OVERRIDE rows survive.
 */
export function clearSolverAssignments(periodId: string): number {
  const info = db
    .prepare(`DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ? AND bron = 'SOLVER'`)
    .run(periodId);
  return info.changes;
}

/**
 * Pool members who could take over a specific slot - active pool members
 * during the period, minus whoever marked the slot ABSOLUUT (manual-assign
 * rejects them anyway), minus anyone who already has another shift within
 * the period's window rule of this slot's week (same hard rule the solver
 * enforces - see lib/windowRule.ts), and minus `excludePersonId` (normally
 * whoever is already assigned - re-picking them isn't a reassignment).
 *
 * Shared by the unfilled-slots gap-filling flow below and the
 * already-assigned reassign flow in the assignments grid, so both offer the
 * same notion of "who is actually eligible".
 */
export function getEligiblePeopleForSlot(
  periodId: string,
  slotId: string,
  excludePersonId?: string
): EligiblePerson[] {
  const period = db
    .prepare(
      `SELECT pool_id, start_datum, eind_datum, bevroren_ruleset_json
       FROM dienstrooster_schedule_period WHERE id = ?`
    )
    .get(periodId) as
    | { pool_id: string; start_datum: string; eind_datum: string; bevroren_ruleset_json: string | null }
    | undefined;

  if (!period) return [];

  const slot = db
    .prepare('SELECT iso_jaar, iso_week FROM dienstrooster_shift_slot WHERE id = ?')
    .get(slotId) as { iso_jaar: number; iso_week: number } | undefined;

  const poolMembers = db
    .prepare(
      `SELECT p.id, p.codenaam FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as EligiblePerson[];

  const blocked = new Set(
    (
      db
        .prepare(
          `SELECT person_id FROM dienstrooster_availability
           WHERE blocking_level = 'ABSOLUUT' AND slot_id = ?`
        )
        .all(slotId) as Array<{ person_id: string }>
    ).map((r) => r.person_id)
  );

  const windowWeeks = getWindowWeeks(period);
  const windowConflicting = slot
    ? getWindowConflictingPersonIds(periodId, slot.iso_jaar, slot.iso_week, windowWeeks, slotId)
    : new Set<string>();

  return poolMembers.filter(
    (p) => !blocked.has(p.id) && !windowConflicting.has(p.id) && p.id !== excludePersonId
  );
}

/** Same fallback default (2) generate-roster uses when a ruleset doesn't name windowWeeks. */
function getWindowWeeks(period: { bevroren_ruleset_json?: string | null; pool_id: string }): number {
  const config = resolveRulesetConfig(period);
  return typeof config.windowWeeks === 'number' ? config.windowWeeks : 2;
}

/**
 * Every slot still short of its required headcount, with the pool members
 * who could take it.
 *
 * People who marked the slot ABSOLUUT are filtered out: manual-assign
 * rejects them anyway, so offering them would be a dead end. Same for
 * anyone the window rule would rule out for this slot's week.
 */
export function findUnfilledSlots(periodId: string): UnfilledSlot[] {
  const period = db
    .prepare(
      `SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json
       FROM dienstrooster_schedule_period WHERE id = ?`
    )
    .get(periodId) as
    | {
        id: string;
        pool_id: string;
        start_datum: string;
        eind_datum: string;
        bevroren_ruleset_json: string | null;
      }
    | undefined;

  if (!period) return [];

  const slots = db
    .prepare(
      `SELECT s.id, s.datum, s.iso_jaar, s.iso_week, st.teller, s.benodigd_aantal_personen,
              (SELECT COUNT(*) FROM dienstrooster_assignment a
               WHERE a.schedule_version_id = ? AND a.slot_id = s.id) as assigned_count
       FROM dienstrooster_shift_slot s
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE s.period_id = ?
       ORDER BY s.datum`
    )
    .all(periodId, periodId) as Array<{
    id: string;
    datum: string;
    iso_jaar: number;
    iso_week: number;
    teller: string;
    benodigd_aantal_personen: number;
    assigned_count: number;
  }>;

  const gaps = slots.filter((s) => s.assigned_count < (s.benodigd_aantal_personen || 1));
  if (gaps.length === 0) return [];

  const poolMembers = db
    .prepare(
      `SELECT p.id, p.codenaam FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as EligiblePerson[];

  const gapSlotIds = gaps.map((g) => g.id);
  const placeholders = gapSlotIds.map(() => '?').join(',');
  const blockedRows = db
    .prepare(
      `SELECT person_id, slot_id FROM dienstrooster_availability
       WHERE blocking_level = 'ABSOLUUT' AND slot_id IN (${placeholders})`
    )
    .all(...gapSlotIds) as Array<{ person_id: string; slot_id: string }>;

  const blockedBySlot = new Map<string, Set<string>>();
  for (const row of blockedRows) {
    if (!blockedBySlot.has(row.slot_id)) blockedBySlot.set(row.slot_id, new Set());
    blockedBySlot.get(row.slot_id)!.add(row.person_id);
  }

  const windowWeeks = getWindowWeeks(period);

  return gaps.map((slot) => {
    const blocked = blockedBySlot.get(slot.id) ?? new Set<string>();
    const windowConflicting = getWindowConflictingPersonIds(
      periodId,
      slot.iso_jaar,
      slot.iso_week,
      windowWeeks,
      slot.id
    );
    const required = slot.benodigd_aantal_personen || 1;
    return {
      slot_id: slot.id,
      datum: slot.datum,
      iso_week: slot.iso_week,
      teller: slot.teller,
      benodigd_aantal_personen: required,
      assigned_count: slot.assigned_count,
      shortfall: required - slot.assigned_count,
      eligible_people: poolMembers.filter((p) => !blocked.has(p.id) && !windowConflicting.has(p.id)),
    };
  });
}
