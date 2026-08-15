/**
 * Slot Generation API Route
 *
 * POST /api/periods/[id]/generate-slots  - Generate and store shift slots
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { persistSlotsForPeriod } from '@/lib/slotPersistence';
import { syncAvailabilityForPeriod } from '@/lib/parttimeSync';
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

    const period = db
      .prepare('SELECT id, start_datum, eind_datum, pool_id FROM dienstrooster_schedule_period WHERE id = ?')
      .get(id) as any;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const result = persistSlotsForPeriod(id, period.pool_id, period.start_datum, period.eind_datum);

    if (!result.success) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: result.code, message: result.message },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Backfill part-time blocking for existing patterns (no-op unless the
    // period is already OPEN, since availability only applies to slots
    // staff can actually see and block against)
    syncAvailabilityForPeriod(id);

    const response: ApiSuccessResponse<SlotGenerationResponse> = {
      success: true,
      data: {
        period_id: id,
        total_slots_generated: result.totalSlotsGenerated,
        weeks_covered: result.weeksCovered,
        slot_status: result.slotStatus,
        validation_errors: result.validationErrors,
        already_existed: result.alreadyExisted,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('generate-slots', error);
  }
}
