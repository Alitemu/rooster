/**
 * GET /api/person/[id]/holiday-history - This person's holiday rotation history
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface HolidayHistoryEntry {
  feestdag_groep: string;
  jaar: number;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;

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

    const history = db
      .prepare(
        `SELECT feestdag_groep, jaar FROM dienstrooster_holiday_history
         WHERE person_id = ? ORDER BY jaar DESC, feestdag_groep`
      )
      .all(id) as HolidayHistoryEntry[];

    const response: ApiSuccessResponse<{ history: HolidayHistoryEntry[] }> = {
      success: true,
      data: { history },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('holiday-history', error);
  }
}
