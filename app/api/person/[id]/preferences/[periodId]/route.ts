/**
 * GET /api/person/[id]/preferences/[periodId] - Get preferences for period
 *
 * Returns every shift slot in the period, left-joined to this person's
 * existing blocking preference. Slots with no preference set yet (the
 * common case, especially on first use) still appear with a null
 * (neutral) blocking_level instead of being omitted - the calendar needs
 * the full slot list to render, not just the ones already touched.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';
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

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; periodId: string } }
): Promise<NextResponse> {
  try {
    const { id, periodId } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
    }

    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const periodStmt = db.prepare(`SELECT id FROM dienstrooster_schedule_period WHERE id = ?`);
    if (!periodStmt.get(periodId)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${periodId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const stmt = db.prepare(`
      SELECT
        s.id as slot_id,
        s.datum,
        s.iso_week,
        st.teller,
        a.blocking_level
      FROM dienstrooster_shift_slot s
      JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
      LEFT JOIN dienstrooster_availability a ON a.slot_id = s.id AND a.person_id = ?
      WHERE s.period_id = ?
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
    return internalErrorResponse('preferences-get', error);
  }
}
