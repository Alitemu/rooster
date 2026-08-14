/**
 * Slot Generation API Route
 *
 * POST /api/periods/[id]/generate-slots  - Generate and store shift slots
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { generateSlotsForPeriod, validateSlots, countWeeksInSlots } from '@/lib/slotGeneration';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface SlotGenerationResponse {
  period_id: string;
  total_slots_generated: number;
  weeks_covered: number;
  slot_status: 'valid' | 'invalid';
  validation_errors: string[];
}

/**
 * POST /api/periods/[id]/generate-slots - Generate slots for period
 *
 * Generates shift_slot entries based on period dates and holidays.
 * Validates slot integrity before returning.
 *
 * Only generates - does not write to database.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
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

    // Fetch shift types for this pool
    const shiftsStmt = db.prepare(`
      SELECT teller
      FROM dienstrooster_shift_type
      WHERE pool_id = ?
    `);

    const shiftRows = shiftsStmt.all(period.pool_id) as any[];
    const shiftTypes = shiftRows.map((r: any) => r.teller);

    if (shiftTypes.length === 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'NO_SHIFT_TYPES',
          message: 'No shift types defined for this pool',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Generate slots
    const slots = generateSlotsForPeriod({
      startDate: period.start_datum,
      endDate: period.eind_datum,
      shiftTypes,
    });

    // Validate slots
    const validation = validateSlots(slots);
    const weeksCovered = countWeeksInSlots(slots);

    // Return results
    const response: ApiSuccessResponse<SlotGenerationResponse> = {
      success: true,
      data: {
        period_id: id,
        total_slots_generated: slots.length,
        weeks_covered: weeksCovered,
        slot_status: validation.valid ? 'valid' : 'invalid',
        validation_errors: validation.errors,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'SLOT_GENERATION_ERROR',
        message: `Failed to generate slots: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}
