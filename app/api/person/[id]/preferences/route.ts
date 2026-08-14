/**
 * Preferences API Routes
 *
 * GET  /api/person/[id]/preferences/[period-id]           - Get preferences
 * PATCH /api/person/[id]/preferences/[slot-id]            - Update single preference
 * POST /api/person/[id]/preferences/submission             - Confirm preferences
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface PreferenceEntry {
  slot_id: string;
  datum: string;
  iso_week: number;
  teller: string;
  blocking_level: string | null; // ABSOLUUT, LIEVER_NIET, or null
}

interface GetPreferencesResponse {
  person_id: string;
  period_id: string;
  preferences: PreferenceEntry[];
  total_entries: number;
}

/**
 * GET /api/person/[id]/preferences/[period-id] - Get preferences for period
 *
 * Returns all availability entries (blocking preferences) for this person in period
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; periodId?: string } }
): Promise<NextResponse> {
  try {
    const { id, periodId } = params;

    if (!periodId) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_PERIOD_ID',
          message: 'Period ID is required',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Verify period exists
    const periodStmt = db.prepare(`SELECT id FROM dienstrooster_schedule_period WHERE id = ?`);
    if (!periodStmt.get(periodId)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${periodId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Fetch preferences (availability blocks)
    const stmt = db.prepare(`
      SELECT
        a.id as slot_id,
        s.datum,
        s.iso_week,
        st.teller,
        a.level as blocking_level
      FROM dienstrooster_availability a
      JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
      JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
      WHERE a.person_id = ? AND s.period_id = ?
      ORDER BY s.datum, st.teller
    `);

    const preferences = stmt.all(id, periodId) as PreferenceEntry[];

    const response: ApiSuccessResponse<GetPreferencesResponse> = {
      success: true,
      data: {
        person_id: id,
        period_id: periodId,
        preferences,
        total_entries: preferences.length,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'PREFERENCES_GET_ERROR',
        message: `Failed to get preferences: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}

/**
 * PATCH /api/person/[id]/preferences/[slot-id] - Update single preference
 *
 * Sets blocking level for a single slot (day + shift counter)
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; slotId?: string } }
): Promise<NextResponse> {
  try {
    const { id, slotId } = params;

    if (!slotId) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_SLOT_ID',
          message: 'Slot ID is required',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const body = (await req.json()) as any;
    const { level } = body; // ABSOLUUT, LIEVER_NIET, or null to clear

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Verify slot exists
    const slotStmt = db.prepare(`SELECT id FROM dienstrooster_shift_slot WHERE id = ?`);
    if (!slotStmt.get(slotId)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'SLOT_NOT_FOUND', message: `Slot ${slotId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    if (level === null) {
      // Delete preference (clear block)
      const deleteStmt = db.prepare(`
        DELETE FROM dienstrooster_availability
        WHERE person_id = ? AND slot_id = ?
      `);

      deleteStmt.run(id, slotId);
    } else {
      // Insert or update preference
      const checkStmt = db.prepare(`
        SELECT id FROM dienstrooster_availability
        WHERE person_id = ? AND slot_id = ?
      `);

      const existing = checkStmt.get(id, slotId);

      if (existing) {
        const updateStmt = db.prepare(`
          UPDATE dienstrooster_availability
          SET level = ?
          WHERE person_id = ? AND slot_id = ?
        `);

        updateStmt.run(level, id, slotId);
      } else {
        const insertStmt = db.prepare(`
          INSERT INTO dienstrooster_availability
          (id, person_id, slot_id, level, source)
          VALUES (?, ?, ?, ?, 'USER_PREFERENCE')
        `);

        insertStmt.run(crypto.randomUUID(), id, slotId, level);
      }
    }

    const response: ApiSuccessResponse<{ updated: boolean }> = {
      success: true,
      data: { updated: true },
    };

    return NextResponse.json(response);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'PREFERENCE_UPDATE_ERROR',
        message: `Failed to update preference: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}
