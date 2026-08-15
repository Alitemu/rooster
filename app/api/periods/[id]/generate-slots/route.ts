/**
 * Slot Generation API Route
 *
 * POST /api/periods/[id]/generate-slots  - Generate and store shift slots
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { generateSlotsForPeriod, validateSlots, countWeeksInSlots } from '@/lib/slotGeneration';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface SlotGenerationResponse {
  period_id: string;
  total_slots_generated: number;
  weeks_covered: number;
  slot_status: 'valid' | 'invalid';
  validation_errors: string[];
  already_existed: boolean;
}

const REQUIRED_TELLERS = ['AVOND', 'WEEKEND', 'FEESTDAG'] as const;

/**
 * POST /api/periods/[id]/generate-slots - Generate and persist slots for period
 *
 * Generates one shift_slot row per day in the period, validates slot
 * integrity, and writes them to the database. Each day gets exactly one
 * slot, categorized into whichever counter applies: a holiday (weekday or
 * weekend) is FEESTDAG, a non-holiday Saturday/Sunday is WEEKEND, and
 * everything else is AVOND.
 *
 * Idempotent: if slots already exist for this period, returns their
 * existing counts instead of inserting duplicates.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;

    // Fetch period details
    const stmt = db.prepare(`
      SELECT
        id,
        start_datum,
        eind_datum,
        pool_id,
        status
      FROM dienstrooster_schedule_period
      WHERE id = ?
    `);

    const period = stmt.get(id) as any;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PERIOD_NOT_FOUND',
          message: `Period ${id} not found`,
        },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Idempotent: don't duplicate slots if this period already has them
    const existingCount = (
      db
        .prepare('SELECT COUNT(*) as count FROM dienstrooster_shift_slot WHERE period_id = ?')
        .get(id) as { count: number }
    ).count;

    if (existingCount > 0) {
      const existingSlots = db
        .prepare('SELECT iso_jaar, iso_week FROM dienstrooster_shift_slot WHERE period_id = ?')
        .all(id) as Array<{ iso_jaar: number; iso_week: number }>;
      const weeksCovered = new Set(existingSlots.map((s) => `${s.iso_jaar}-${s.iso_week}`)).size;

      const response: ApiSuccessResponse<SlotGenerationResponse> = {
        success: true,
        data: {
          period_id: id,
          total_slots_generated: existingCount,
          weeks_covered: weeksCovered,
          slot_status: 'valid',
          validation_errors: [],
          already_existed: true,
        },
      };
      return NextResponse.json(response);
    }

    // Fetch shift types for this pool
    const shiftsStmt = db.prepare(`
      SELECT id, teller
      FROM dienstrooster_shift_type
      WHERE pool_id = ?
    `);

    const shiftRows = shiftsStmt.all(period.pool_id) as Array<{ id: string; teller: string }>;

    if (shiftRows.length === 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'NO_SHIFT_TYPES',
          message: 'No shift types defined for this pool',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // One shift_type id per counter (a pool may have more than one row per
    // counter, e.g. separate Saturday/Sunday rows both tellered WEEKEND;
    // any one of them works since slots reference a specific row but
    // everything downstream keys off teller, not shift_type_id)
    const shiftTypeIdByTeller = new Map<string, string>();
    for (const row of shiftRows) {
      if (!shiftTypeIdByTeller.has(row.teller)) {
        shiftTypeIdByTeller.set(row.teller, row.id);
      }
    }

    const missingTellers = REQUIRED_TELLERS.filter((t) => !shiftTypeIdByTeller.has(t));
    if (missingTellers.length > 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_SHIFT_TYPES',
          message: `Pool is missing shift types for: ${missingTellers.join(', ')}`,
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Generate slots
    const slots = generateSlotsForPeriod({
      startDate: period.start_datum,
      endDate: period.eind_datum,
      shiftTypes: Array.from(shiftTypeIdByTeller.keys()),
    });

    // Validate slots
    const validation = validateSlots(slots);
    const weeksCovered = countWeeksInSlots(slots);

    // Persist: one row per day, categorized by counter (holiday takes
    // priority over weekend, which takes priority over weekday/AVOND)
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
          id,
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

    // Return results
    const response: ApiSuccessResponse<SlotGenerationResponse> = {
      success: true,
      data: {
        period_id: id,
        total_slots_generated: slots.length,
        weeks_covered: weeksCovered,
        slot_status: validation.valid ? 'valid' : 'invalid',
        validation_errors: validation.errors,
        already_existed: false,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('generate-slots', error);
  }
}
