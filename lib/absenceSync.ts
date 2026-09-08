/**
 * Absence -> availability sync
 *
 * An absence (vacation/sick leave/leave) is a date range; the actual
 * blocking happens as ABSOLUUT availability rows with source=ABSENCE, one
 * per matching shift_slot, linked back via bron_absence_id. This mirrors
 * lib/parttimeSync.ts exactly - the same reconcile-by-date-range approach,
 * just against a fixed [van_datum, tot_datum] range instead of a recurring
 * weekday rule. Without this, registering an absence recorded nothing
 * against any shift slot and could never actually keep someone off the
 * roster during it.
 *
 * Shared by the absences routes (create/update/delete) and the period
 * open/generate-slots routes (backfill for existing absences when a
 * period's slots are first created).
 */

import { db } from '@/db/client';
import { getOpenPeriodsForPerson } from '@/lib/parttimeSync';

export interface AbsenceRow {
  id: string;
  person_id: string;
  van_datum: string;
  tot_datum: string;
}

interface SlotForMatching {
  id: string;
  datum: string;
}

export interface SyncResult {
  inserted: number;
  deleted: number;
  skippedManualConflicts: number;
  periodsAffected: string[];
}

/** Pure matching: which of these slots fall within the absence's date range? */
export function matchSlotsToAbsence(absence: Pick<AbsenceRow, 'van_datum' | 'tot_datum'>, slots: SlotForMatching[]): string[] {
  return slots
    .filter((slot) => slot.datum >= absence.van_datum && slot.datum <= absence.tot_datum)
    .map((slot) => slot.id);
}

/**
 * Reconciles one absence's ABSENCE rows against one period's slots: deletes
 * stale rows this absence owns, inserts missing ones, and skips (never
 * overwrites) any slot that already has a different-source row - a person
 * can only have one availability row per slot (availability_uniq), so an
 * existing MANUAL block or another absence's row is never clobbered.
 */
function reconcileAbsenceForPeriod(absence: AbsenceRow, periodId: string): SyncResult {
  const slots = db
    .prepare('SELECT id, datum FROM dienstrooster_shift_slot WHERE period_id = ?')
    .all(periodId) as SlotForMatching[];

  const targetSlotIds = new Set(matchSlotsToAbsence(absence, slots));

  const currentRows = db
    .prepare(
      `SELECT a.slot_id FROM dienstrooster_availability a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       WHERE a.bron_absence_id = ? AND s.period_id = ?`
    )
    .all(absence.id, periodId) as Array<{ slot_id: string }>;
  const currentSlotIds = new Set(currentRows.map((r) => r.slot_id));

  const toDelete = [...currentSlotIds].filter((id) => !targetSlotIds.has(id));
  if (toDelete.length > 0) {
    const placeholders = toDelete.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM dienstrooster_availability WHERE bron_absence_id = ? AND slot_id IN (${placeholders})`
    ).run(absence.id, ...toDelete);
  }

  const toCheck = [...targetSlotIds].filter((id) => !currentSlotIds.has(id));
  let skippedManualConflicts = 0;
  let inserted = 0;

  if (toCheck.length > 0) {
    const existingStmt = db.prepare(
      'SELECT source FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?'
    );
    const insertStmt = db.prepare(
      `INSERT INTO dienstrooster_availability
       (id, person_id, slot_id, blocking_level, source, bron_absence_id, aangemaakt_op)
       VALUES (?, ?, ?, 'ABSOLUUT', 'ABSENCE', ?, ?)`
    );
    const now = new Date().toISOString();

    for (const slotId of toCheck) {
      const existing = existingStmt.get(absence.person_id, slotId) as { source: string } | undefined;
      if (existing) {
        skippedManualConflicts++;
        continue;
      }
      insertStmt.run(crypto.randomUUID(), absence.person_id, slotId, absence.id, now);
      inserted++;
    }
  }

  return {
    inserted,
    deleted: toDelete.length,
    skippedManualConflicts,
    periodsAffected: inserted > 0 || toDelete.length > 0 ? [periodId] : [],
  };
}

/**
 * Reconciles one absence's availability rows across every OPEN period the
 * absence's person currently belongs to. Idempotent - safe to call after
 * every absence create/update.
 */
export function syncAvailabilityForAbsence(absenceId: string): SyncResult {
  const absence = db
    .prepare('SELECT id, person_id, van_datum, tot_datum FROM dienstrooster_absence WHERE id = ?')
    .get(absenceId) as AbsenceRow | undefined;

  if (!absence) {
    return { inserted: 0, deleted: 0, skippedManualConflicts: 0, periodsAffected: [] };
  }

  const periodIds = getOpenPeriodsForPerson(absence.person_id);

  const result: SyncResult = { inserted: 0, deleted: 0, skippedManualConflicts: 0, periodsAffected: [] };

  const run = db.transaction(() => {
    for (const periodId of periodIds) {
      const periodResult = reconcileAbsenceForPeriod(absence, periodId);
      result.inserted += periodResult.inserted;
      result.deleted += periodResult.deleted;
      result.skippedManualConflicts += periodResult.skippedManualConflicts;
      result.periodsAffected.push(...periodResult.periodsAffected);
    }
  });
  run();

  return result;
}

/**
 * Hard-removes every availability row this absence generated, in every
 * period regardless of status. Must run before deleting the absence row
 * itself - bron_absence_id has no ON DELETE clause and foreign_keys=ON.
 */
export function removeAbsenceAvailability(absenceId: string): { deleted: number } {
  const result = db
    .prepare('DELETE FROM dienstrooster_availability WHERE bron_absence_id = ?')
    .run(absenceId);
  return { deleted: result.changes };
}

/**
 * Backfills ABSENCE rows for every pool member's absences, scoped to one
 * period. Called after a period's slots are (re)generated so absences
 * registered before the period opened still take effect - mirrors
 * lib/parttimeSync.ts's syncAvailabilityForPeriod.
 */
export function syncAvailabilityForPeriod(periodId: string): { inserted: number; absencesProcessed: number } {
  const period = db
    .prepare('SELECT pool_id, status, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as { pool_id: string; status: string; start_datum: string; eind_datum: string } | undefined;

  if (!period || period.status !== 'OPEN') {
    return { inserted: 0, absencesProcessed: 0 };
  }

  const absences = db
    .prepare(
      `SELECT DISTINCT ab.id, ab.person_id, ab.van_datum, ab.tot_datum
       FROM dienstrooster_absence ab
       JOIN dienstrooster_pool_membership pm ON pm.person_id = ab.person_id
       JOIN dienstrooster_person p ON p.id = ab.person_id
       WHERE pm.pool_id = ?
         AND ab.van_datum <= ? AND ab.tot_datum >= ?
         AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ?
         AND p.actief = 1`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum, period.eind_datum, period.start_datum) as AbsenceRow[];

  let inserted = 0;
  const run = db.transaction(() => {
    for (const absence of absences) {
      inserted += reconcileAbsenceForPeriod(absence, periodId).inserted;
    }
  });
  run();

  return { inserted, absencesProcessed: absences.length };
}
