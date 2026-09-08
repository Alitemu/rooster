/**
 * Pool Detail Route
 *
 * PATCH /api/planner/pools/[id] - Activate/deactivate a pool. A
 * deactivated pool drops out of the default GET /api/planner/pools list
 * (so it can no longer be picked when opening a new period) without
 * touching its existing periods, staff, or history.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface UpdatePoolRequest {
  actief?: boolean;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const poolId = params.id;
    const body = (await parseJsonBody(req)) as UpdatePoolRequest;

    if (body.actief === undefined) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'NO_UPDATES', message: 'Geen velden om bij te werken' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const pool = db.prepare('SELECT id FROM dienstrooster_pool WHERE id = ?').get(poolId);
    if (!pool) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'POOL_NOT_FOUND', message: `Pool ${poolId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    db.prepare('UPDATE dienstrooster_pool SET actief = ? WHERE id = ?').run(
      body.actief ? 1 : 0,
      poolId
    );

    const response: ApiSuccessResponse<{ id: string; actief: boolean }> = {
      success: true,
      data: { id: poolId, actief: body.actief },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('planner-pool-update', error);
  }
}
