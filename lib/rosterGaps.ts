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

/**
 * Why a candidate needs a second look before being picked - never a
 * reason to exclude them (see getEligiblePeopleForSlot below). Ordered
 * roughly from "just informational" to "an explicit signal from the
 * person themselves":
 *  - BESCHIKBAAR: no conflict at all.
 *  - VENSTERBLOK: would violate the window rule (derived from their other
 *    assignments in this period - see lib/windowRule.ts).
 *  - PARTTIME: this is a part-time-free day for them (ABSOLUUT block
 *    sourced from a part-time pattern).
 *  - GEBLOKKEERD: they blocked this exact day themselves (ABSOLUUT block
 *    from a manual entry or imported absence).
 * A person can only be in one category: an ABSOLUUT block on the slot
 * itself outranks a window conflict derived from other slots, since it's
 * the more direct, more specific signal.
 */
export type EligibilityCategory = 'BESCHIKBAAR' | 'VENSTERBLOK' | 'PARTTIME' | 'GEBLOKKEERD';

export interface EligiblePerson {
  id: string;
  codenaam: string;
  category: EligibilityCategory;
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

function categorize(blockedSource: string | undefined, windowConflict: boolean): EligibilityCategory {
  if (blockedSource === 'PARTTIME') return 'PARTTIME';
  if (blockedSource) return 'GEBLOKKEERD';
  if (windowConflict) return 'VENSTERBLOK';
  return 'BESCHIKBAAR';
}

/** Same fallback default (2) generate-roster uses when a ruleset doesn't name windowWeeks. */
function getWindowWeeks(period: { bevroren_ruleset_json?: string | null; pool_id: string }): number {
  const config = resolveRulesetConfig(period);
  return typeof config.windowWeeks === 'number' ? config.windowWeeks : 2;
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
 * during the period, minus `excludePersonId` (normally whoever is already
 * assigned - re-picking them isn't a reassignment).
 *
 * Nobody is excluded for being blocked or window-conflicted: a planner
 * filling a gap or swapping a shift by hand is making a deliberate
 * exception, in consultation with the person taking it, and must be able
 * to pick anyone in the pool. Each person's `category` says why they need
 * a second look, so the manual-assign UI can group the candidate list
 * (beschikbaar / vensterblok / parttime / geblokkeerd) instead of hiding
 * anyone.
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
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ id: string; codenaam: string }>;

  const blockedSource = new Map(
    (
      db
        .prepare(
          `SELECT person_id, source FROM dienstrooster_availability
           WHERE blocking_level = 'ABSOLUUT' AND slot_id = ?`
        )
        .all(slotId) as Array<{ person_id: string; source: string }>
    ).map((r) => [r.person_id, r.source])
  );

  const windowWeeks = getWindowWeeks(period);
  const windowConflicting = slot
    ? getWindowConflictingPersonIds(periodId, slot.iso_jaar, slot.iso_week, windowWeeks, slotId)
    : new Set<string>();

  return poolMembers
    .filter((p) => p.id !== excludePersonId)
    .map((p) => ({
      ...p,
      category: categorize(blockedSource.get(p.id), windowConflicting.has(p.id)),
    }));
}

/**
 * Every slot still short of its required headcount, with the pool members
 * who could take it, each with their `category` - see
 * getEligiblePeopleForSlot above for why nobody is filtered out.
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
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ id: string; codenaam: string }>;

  const gapSlotIds = gaps.map((g) => g.id);
  const placeholders = gapSlotIds.map(() => '?').join(',');
  const blockedRows = db
    .prepare(
      `SELECT person_id, slot_id, source FROM dienstrooster_availability
       WHERE blocking_level = 'ABSOLUUT' AND slot_id IN (${placeholders})`
    )
    .all(...gapSlotIds) as Array<{ person_id: string; slot_id: string; source: string }>;

  const blockedBySlot = new Map<string, Map<string, string>>();
  for (const row of blockedRows) {
    if (!blockedBySlot.has(row.slot_id)) blockedBySlot.set(row.slot_id, new Map());
    blockedBySlot.get(row.slot_id)!.set(row.person_id, row.source);
  }

  const windowWeeks = getWindowWeeks(period);

  return gaps.map((slot) => {
    const blockedSource = blockedBySlot.get(slot.id) ?? new Map<string, string>();
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
      eligible_people: poolMembers.map((p) => ({
        ...p,
        category: categorize(blockedSource.get(p.id), windowConflicting.has(p.id)),
      })),
    };
  });
}
