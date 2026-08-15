/**
 * POST /api/periods/[id]/close - Close an OPEN period
 *
 * Transitions OPEN -> GESLOTEN: preferences are read-only from this point,
 * ahead of roster generation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiErrorResponse, ApiSuccessResponse } from '@/types';

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
      .prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?')
      .get(id) as { status: string } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    if (period.status !== 'OPEN') {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_STATUS', message: `Cannot close period in ${period.status} status` },
      };
      return NextResponse.json(response, { status: 400 });
    }

    db.prepare(
      `UPDATE dienstrooster_schedule_period
       SET status = 'GESLOTEN', row_version = row_version + 1
       WHERE id = ?`
    ).run(id);

    const response: ApiSuccessResponse<{ status: string }> = {
      success: true,
      data: { status: 'GESLOTEN' },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('close-period', error);
  }
}
