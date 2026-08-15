/**
 * Slot persistence
 *
 * Shared by /api/periods/[id]/generate-slots and /api/periods/[id]/open -
 * both need "make sure this period has real shift_slot rows."
 */

import { db } from '@/db/client';
import { generateSlotsForPeriod, validateSlots, countWeeksInSlots } from '@/lib/slotGeneration';

export interface PersistSlotsResult {
  success: true;
  totalSlotsGenerated: number;
  weeksCovered: number;
  slotStatus: 'valid' | 'invalid';
  validationErrors: string[];
  alreadyExisted: boolean;
}

export interface PersistSlotsError {
  success: false;
  code: string;
  message: string;
}

const REQUIRED_TELLERS = ['AVOND', 'WEEKEND', 'FEESTDAG'] as const;

/**
 * Idempotent: if the period already has slots, returns their existing
 * counts instead of inserting duplicates.
 */
export function persistSlotsForPeriod(
  periodId: string,
  poolId: string,
  startDatum: string,
  eindDatum: string
): PersistSlotsResult | PersistSlotsError {
  const existingCount = (
    db
      .prepare('SELECT COUNT(*) as count FROM dienstrooster_shift_slot WHERE period_id = ?')
      .get(periodId) as { count: number }
  ).count;

  if (existingCount > 0) {
    const existingSlots = db
      .prepare('SELECT iso_jaar, iso_week FROM dienstrooster_shift_slot WHERE period_id = ?')
      .all(periodId) as Array<{ iso_jaar: number; iso_week: number }>;
    const weeksCovered = new Set(existingSlots.map((s) => `${s.iso_jaar}-${s.iso_week}`)).size;

    return {
      success: true,
      totalSlotsGenerated: existingCount,
      weeksCovered,
      slotStatus: 'valid',
      validationErrors: [],
      alreadyExisted: true,
    };
  }

  const shiftRows = db
    .prepare('SELECT id, teller FROM dienstrooster_shift_type WHERE pool_id = ?')
    .all(poolId) as Array<{ id: string; teller: string }>;

  if (shiftRows.length === 0) {
    return { success: false, code: 'NO_SHIFT_TYPES', message: 'No shift types defined for this pool' };
  }

  // One shift_type id per counter (a pool may have more than one row per
  // counter, e.g. separate Saturday/Sunday rows both tellered WEEKEND; any
  // one of them works since slots reference a specific row but everything
  // downstream keys off teller, not shift_type_id)
  const shiftTypeIdByTeller = new Map<string, string>();
  for (const row of shiftRows) {
    if (!shiftTypeIdByTeller.has(row.teller)) {
      shiftTypeIdByTeller.set(row.teller, row.id);
    }
  }

  const missingTellers = REQUIRED_TELLERS.filter((t) => !shiftTypeIdByTeller.has(t));
  if (missingTellers.length > 0) {
    return {
      success: false,
      code: 'MISSING_SHIFT_TYPES',
      message: `Pool is missing shift types for: ${missingTellers.join(', ')}`,
    };
  }

  const slots = generateSlotsForPeriod({
    startDate: startDatum,
    endDate: eindDatum,
    shiftTypes: Array.from(shiftTypeIdByTeller.keys()),
  });

  const validation = validateSlots(slots);
  const weeksCovered = countWeeksInSlots(slots);

  const insertStmt = db.prepare(`
    INSERT INTO dienstrooster_shift_slot
      (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id,
       is_feestdag, feestdag_groep, benodigd_aantal_personen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const insertAll = db.transaction((rows: typeof slots) => {
    for (const slot of rows) {
      const teller = slot.is_feestdag ? 'FEESTDAG' : slot.weekend_id ? 'WEEKEND' : 'AVOND';
      const shiftTypeId = shiftTypeIdByTeller.get(teller)!;

      insertStmt.run(
        crypto.randomUUID(),
        periodId,
        shiftTypeId,
        slot.datum,
        slot.iso_jaar,
        slot.iso_week,
        slot.weekend_id || null,
        slot.is_feestdag ? 1 : 0,
        slot.feestdag_groep
      );
    }
  });

  insertAll(slots);

  return {
    success: true,
    totalSlotsGenerated: slots.length,
    weeksCovered,
    slotStatus: validation.valid ? 'valid' : 'invalid',
    validationErrors: validation.errors,
    alreadyExisted: false,
  };
}
