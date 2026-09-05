/**
 * Part-time pattern -> availability sync
 *
 * A part-time pattern (e.g. "off every other Wednesday") is a rule; the
 * actual blocking happens as ABSOLUUT availability rows with
 * source=PARTTIME, one per matching shift_slot. This module keeps those
 * rows in sync with the pattern that generated them, without ever
 * touching a slot a person has manually blocked themselves.
 *
 * Shared by the parttime-patterns routes (create/update/delete) and the
 * period open/generate-slots routes (backfill for existing patterns when
 * a period's slots are first created), the same way lib/slotPersistence.ts
 * is shared by its two callers.
 */

import { db } from '@/db/client';
import { parseISO, dateToISO, getISOWeek } from '@/lib/holidays';

export type Weekdag = 'MA' | 'DI' | 'WO' | 'DO' | 'VR' | 'ZA' | 'ZO';
export type Frequentie = 'ELKE_WEEK' | 'EVEN_WEKEN' | 'ONEVEN_WEKEN';

const WEEKDAG_TO_JS_DAY: Record<Weekdag, number> = {
  ZO: 0,
  MA: 1,
  DI: 2,
  WO: 3,
  DO: 4,
  VR: 5,
  ZA: 6,
};

// A part-time pattern only ever means "I don't work this weekday" - the
// weekend shift counter (WEEKEND) is separate, so ZA/ZO are excluded from
// what a new/edited pattern may target even though the type above (and the
// matching logic) still has to understand them for any pattern that
// predates this rule.
export const PARTTIME_WEEKDAGEN: Weekdag[] = ['MA', 'DI', 'WO', 'DO', 'VR'];

export interface ParttimePatternRow {
  id: string;
  person_id: string;
  weekdag: Weekdag;
  frequentie: Frequentie;
  geldig_vanaf: string;
  geldig_tot: string;
}

interface SlotForMatching {
  id: string;
  datum: string;
  iso_week: number;
}

export interface SyncResult {
  inserted: number;
  deleted: number;
  skippedManualConflicts: number;
  periodsAffected: string[];
}

export type PatternRule = Pick<ParttimePatternRow, 'weekdag' | 'frequentie' | 'geldig_vanaf' | 'geldig_tot'>;

/**
 * The one predicate that decides whether a pattern covers a given date -
 * shared by the real matching below (against actual slots) and the preview
 * generator (against a plain date range, for a period that has no slots
 * yet because it hasn't been opened). Keeping this in one place means a
 * preview shown before a period opens can never drift from what actually
 * gets blocked once it does.
 */
function dateMatchesPattern(pattern: PatternRule, datum: string, isoWeek: number): boolean {
  if (datum < pattern.geldig_vanaf || datum > pattern.geldig_tot) return false;
  if (parseISO(datum).getDay() !== WEEKDAG_TO_JS_DAY[pattern.weekdag]) return false;
  if (pattern.frequentie === 'EVEN_WEKEN' && isoWeek % 2 !== 0) return false;
  if (pattern.frequentie === 'ONEVEN_WEKEN' && isoWeek % 2 !== 1) return false;
  return true;
}

/**
 * Pure matching: which of these slots does this pattern cover?
 * Uses the slot's already-computed iso_week (from slot generation) for
 * EVEN_WEKEN/ONEVEN_WEKEN parity - never recompute ISO week math here.
 */
export function matchSlotsToPattern(pattern: PatternRule, slots: SlotForMatching[]): string[] {
  return slots.filter((slot) => dateMatchesPattern(pattern, slot.datum, slot.iso_week)).map((slot) => slot.id);
}

export interface PreviewedDay {
  datum: string;
  iso_jaar: number;
  iso_week: number;
}

/**
 * Which dates in [rangeStart, rangeEnd] this pattern would cover - for a
 * period that doesn't have real shift slots yet (still CONCEPT, not opened
 * by the planner). Intersects the pattern's own validity range with the
 * given range first, so a pattern that only partially overlaps the period
 * doesn't preview days outside either.
 */
export function previewPatternDates(pattern: PatternRule, rangeStart: string, rangeEnd: string): PreviewedDay[] {
  const from = rangeStart > pattern.geldig_vanaf ? rangeStart : pattern.geldig_vanaf;
  const to = rangeEnd < pattern.geldig_tot ? rangeEnd : pattern.geldig_tot;
  if (from > to) return [];

  const days: PreviewedDay[] = [];
  const cursor = parseISO(from);
  const end = parseISO(to);
  while (cursor <= end) {
    const datum = dateToISO(cursor);
    const [isoYear, isoWeek] = getISOWeek(cursor);
    if (dateMatchesPattern(pattern, datum, isoWeek)) {
      days.push({ datum, iso_jaar: isoYear, iso_week: isoWeek });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function isYearBoundaryWeek(isoWeek: number): boolean {
  return isoWeek === 1 || isoWeek === 52 || isoWeek === 53;
}

export interface BlockedElsewhereDay {
  datum: string;
  pattern_id: string;
  source: string;
}

/**
 * Days one or more patterns would cover but that already have a different
 * source's availability row on that slot - reconcilePatternForPeriod
 * deliberately skips inserting a PARTTIME row there rather than
 * overwriting it (see its own doc comment). That day is still genuinely
 * blocked, just not tagged PARTTIME, so without surfacing this separately
 * a participant checking their pattern against the calendar would see a
 * plain, seemingly unblocked day and have no way to tell their pattern
 * didn't actually "miss" it - something else already covers it.
 */
export function findBlockedElsewhereDays(
  patterns: Array<{ id: string } & PatternRule>,
  slots: SlotForMatching[],
  generatedDatums: Set<string>,
  otherSourceBySlotId: Map<string, string>
): BlockedElsewhereDay[] {
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const results: BlockedElsewhereDay[] = [];

  for (const pattern of patterns) {
    for (const slotId of matchSlotsToPattern(pattern, slots)) {
      const slot = slotById.get(slotId)!;
      if (generatedDatums.has(slot.datum)) continue;
      const source = otherSourceBySlotId.get(slotId);
      if (source) {
        results.push({ datum: slot.datum, pattern_id: pattern.id, source });
      }
    }
  }

  return results;
}

/**
 * Reconciles one pattern's PARTTIME rows against one period's slots:
 * deletes stale rows this pattern owns, inserts missing ones, and skips
 * (never overwrites) any slot that already has a non-PARTTIME row.
 */
function reconcilePatternForPeriod(pattern: ParttimePatternRow, periodId: string): SyncResult {
  const slots = db
    .prepare('SELECT id, datum, iso_week FROM dienstrooster_shift_slot WHERE period_id = ?')
    .all(periodId) as SlotForMatching[];

  const targetSlotIds = new Set(matchSlotsToPattern(pattern, slots));

  const currentRows = db
    .prepare(
      `SELECT a.slot_id FROM dienstrooster_availability a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       WHERE a.bron_pattern_id = ? AND s.period_id = ?`
    )
    .all(pattern.id, periodId) as Array<{ slot_id: string }>;
  const currentSlotIds = new Set(currentRows.map((r) => r.slot_id));

  const toDelete = [...currentSlotIds].filter((id) => !targetSlotIds.has(id));
  if (toDelete.length > 0) {
    const placeholders = toDelete.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM dienstrooster_availability WHERE bron_pattern_id = ? AND slot_id IN (${placeholders})`
    ).run(pattern.id, ...toDelete);
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
       (id, person_id, slot_id, blocking_level, source, bron_pattern_id, aangemaakt_op)
       VALUES (?, ?, ?, 'ABSOLUUT', 'PARTTIME', ?, ?)`
    );
    const now = new Date().toISOString();

    for (const slotId of toCheck) {
      const existing = existingStmt.get(pattern.person_id, slotId) as { source: string } | undefined;
      if (existing) {
        skippedManualConflicts++;
        continue;
      }
      insertStmt.run(crypto.randomUUID(), pattern.person_id, slotId, pattern.id, now);
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

export function getOpenPeriodsForPerson(personId: string): string[] {
  const rows = db
    .prepare(
      `SELECT sp.id
       FROM dienstrooster_schedule_period sp
       JOIN dienstrooster_pool_membership pm ON pm.pool_id = sp.pool_id
       WHERE pm.person_id = ?
         AND sp.status = 'OPEN'
         AND pm.geldig_vanaf <= sp.eind_datum AND pm.geldig_tot >= sp.start_datum`
    )
    .all(personId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Reconciles one pattern's availability rows across every OPEN period the
 * pattern's person currently belongs to. Idempotent - safe to call after
 * every pattern create/update.
 */
export function syncAvailabilityForPattern(patternId: string): SyncResult {
  const pattern = db
    .prepare(
      `SELECT id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot
       FROM dienstrooster_parttime_pattern WHERE id = ?`
    )
    .get(patternId) as ParttimePatternRow | undefined;

  if (!pattern) {
    return { inserted: 0, deleted: 0, skippedManualConflicts: 0, periodsAffected: [] };
  }

  const periodIds = getOpenPeriodsForPerson(pattern.person_id);

  const result: SyncResult = { inserted: 0, deleted: 0, skippedManualConflicts: 0, periodsAffected: [] };

  const run = db.transaction(() => {
    for (const periodId of periodIds) {
      const periodResult = reconcilePatternForPeriod(pattern, periodId);
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
 * Hard-removes every availability row this pattern generated, in every
 * period regardless of status. Must run before deleting the pattern row
 * itself - bron_pattern_id has no ON DELETE clause and foreign_keys=ON.
 */
export function removePatternAvailability(patternId: string): { deleted: number } {
  const result = db
    .prepare('DELETE FROM dienstrooster_availability WHERE bron_pattern_id = ?')
    .run(patternId);
  return { deleted: result.changes };
}

/**
 * Backfills PARTTIME rows for every active pattern of every pool member,
 * scoped to one period. Called after a period's slots are (re)generated
 * so patterns created before the period opened still take effect.
 */
export function syncAvailabilityForPeriod(periodId: string): { inserted: number; patternsProcessed: number } {
  const period = db
    .prepare('SELECT pool_id, status, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as { pool_id: string; status: string; start_datum: string; eind_datum: string } | undefined;

  if (!period || period.status !== 'OPEN') {
    return { inserted: 0, patternsProcessed: 0 };
  }

  const patterns = db
    .prepare(
      `SELECT DISTINCT pp.id, pp.person_id, pp.weekdag, pp.frequentie, pp.geldig_vanaf, pp.geldig_tot
       FROM dienstrooster_parttime_pattern pp
       JOIN dienstrooster_pool_membership pm ON pm.person_id = pp.person_id
       WHERE pm.pool_id = ?
         AND pp.geldig_vanaf <= ? AND pp.geldig_tot >= ?
         AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ?`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum, period.eind_datum, period.start_datum) as ParttimePatternRow[];

  let inserted = 0;
  const run = db.transaction(() => {
    for (const pattern of patterns) {
      inserted += reconcilePatternForPeriod(pattern, periodId).inserted;
    }
  });
  run();

  return { inserted, patternsProcessed: patterns.length };
}
