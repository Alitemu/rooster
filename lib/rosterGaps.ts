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

export type BlockedReason = 'PARTTIME' | 'GEBLOKKEERD';

export interface EligiblePerson {
  id: string;
  codenaam: string;
  /**
   * Set when this person marked the slot ABSOLUUT. Not excluded from the
   * list - a manual fill is a deliberate planner exception made in
   * consultation with the person, so blocking someone from being picked
   * here would defeat that. The reason is surfaced instead, so the
   * planner sees it before overriding: 'PARTTIME' when the block comes
   * from a part-time pattern, 'GEBLOKKEERD' for any other block (manual
   * or imported absence).
   */
  blocked_reason?: BlockedReason;
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

function toBlockedReason(source: string): BlockedReason {
  return source === 'PARTTIME' ? 'PARTTIME' : 'GEBLOKKEERD';
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
 * Whoever marked the slot ABSOLUUT stays in the list, flagged via
 * `blocked_reason`: a planner filling a gap or swapping a shift by hand is
 * making a deliberate exception, in consultation with the person taking
 * it, and must be able to pick anyone in the pool - including someone
 * who blocked the day - as long as that's shown clearly before they do.
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
      'SELECT pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?'
    )
    .get(periodId) as { pool_id: string; start_datum: string; eind_datum: string } | undefined;

  if (!period) return [];

  const poolMembers = db
    .prepare(
      `SELECT p.id, p.codenaam FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as EligiblePerson[];

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

  return poolMembers
    .filter((p) => p.id !== excludePersonId)
    .map((p) => {
      const source = blockedSource.get(p.id);
      return source ? { ...p, blocked_reason: toBlockedReason(source) } : p;
    });
}

/**
 * Every slot still short of its required headcount, with the pool members
 * who could take it.
 *
 * Whoever marked the slot ABSOLUUT stays in `eligible_people`, flagged via
 * `blocked_reason` - see getEligiblePeopleForSlot above for why.
 */
export function findUnfilledSlots(periodId: string): UnfilledSlot[] {
  const period = db
    .prepare(
      'SELECT id, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?'
    )
    .get(periodId) as
    | { id: string; pool_id: string; start_datum: string; eind_datum: string }
    | undefined;

  if (!period) return [];

  const slots = db
    .prepare(
      `SELECT s.id, s.datum, s.iso_week, st.teller, s.benodigd_aantal_personen,
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
      `SELECT person_id, slot_id, source FROM dienstrooster_availability
       WHERE blocking_level = 'ABSOLUUT' AND slot_id IN (${placeholders})`
    )
    .all(...gapSlotIds) as Array<{ person_id: string; slot_id: string; source: string }>;

  const blockedBySlot = new Map<string, Map<string, string>>();
  for (const row of blockedRows) {
    if (!blockedBySlot.has(row.slot_id)) blockedBySlot.set(row.slot_id, new Map());
    blockedBySlot.get(row.slot_id)!.set(row.person_id, row.source);
  }

  return gaps.map((slot) => {
    const blockedSource = blockedBySlot.get(slot.id) ?? new Map<string, string>();
    const required = slot.benodigd_aantal_personen || 1;
    return {
      slot_id: slot.id,
      datum: slot.datum,
      iso_week: slot.iso_week,
      teller: slot.teller,
      benodigd_aantal_personen: required,
      assigned_count: slot.assigned_count,
      shortfall: required - slot.assigned_count,
      eligible_people: poolMembers.map((p) => {
        const source = blockedSource.get(p.id);
        return source ? { ...p, blocked_reason: toBlockedReason(source) } : p;
      }),
    };
  });
}
