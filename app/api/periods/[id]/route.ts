/**
 * Period Detail API Route
 *
 * GET    /api/periods/[id]  - Get detailed period information
 * DELETE /api/periods/[id]  - Move a period to the trash (soft-delete)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { softDeletePeriod, PeriodTrashError } from '@/lib/periodTrash';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface PeriodDetail {
  id: string;
  pool_id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
  bevroren_ruleset_json: string | null;
  overloop_bevestigd_op: string | null;
  gepubliceerd_op: string | null;
  row_version: number;
  verwijderd_op: string | null;
}

/**
 * GET /api/periods/[id] - Get period details
 *
 * Returns full period information including frozen ruleset and confirmation status
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    // Both staff and any authenticated person need this: the person page
    // reads their own current period's name/dates/status through it.
    const auth = getAuthContextFromRequest(req);
    if (!auth) {
      return unauthorizedResponse();
    }

    const { id } = params;

    // Validate ID format
    if (!id || typeof id !== 'string') {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_PERIOD_ID',
          message: 'Periode-ID moet een geldige tekenreeks zijn',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const stmt = db.prepare(`
      SELECT
        id,
        pool_id,
        naam,
        start_datum,
        eind_datum,
        deadline,
        status,
        bevroren_ruleset_json,
        overloop_bevestigd_op,
        gepubliceerd_op,
        row_version,
        verwijderd_op
      FROM dienstrooster_schedule_period
      WHERE id = ?
    `);

    const row = stmt.get(id) as PeriodDetail | undefined;

    if (!row) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PERIOD_NOT_FOUND',
          message: `Period with ID ${id} not found`,
        },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const response: ApiSuccessResponse<PeriodDetail> = {
      success: true,
      data: row,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-detail', error);
  }
}

/**
 * DELETE /api/periods/[id] - Move a period to the trash
 *
 * Soft-delete only: the period is recoverable via POST .../restore for
 * RETENTION_DAYS, after which it is purged automatically. Use
 * POST .../purge to skip the wait and delete it permanently right away.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;

    try {
      softDeletePeriod(id, auth!.userId);
    } catch (error) {
      if (error instanceof PeriodTrashError) {
        const status = error.code === 'NOT_FOUND' ? 404 : 409;
        const response: ApiErrorResponse = {
          success: false,
          error: { code: error.code, message: error.message },
        };
        return NextResponse.json(response, { status });
      }
      throw error;
    }

    const response: ApiSuccessResponse<{ deleted: boolean }> = {
      success: true,
      data: { deleted: true },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-delete', error);
  }
}
