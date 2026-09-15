/**
 * GET /api/planner/period/[id]/rebalance-suggestions
 *
 * Suggestion-only: never writes anything. Each suggestion names an existing
 * dienst and a person who could take it instead - accepting one is just a
 * normal reassign (POST .../assignments/[id]/reassign), the same action a
 * planner already has for any other dienst.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { suggestRebalances } from '@/lib/rebalanceSuggestions';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;

    const period = db
      .prepare('SELECT id FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId);

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${periodId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const suggestions = suggestRebalances(periodId);

    const response: ApiSuccessResponse<typeof suggestions> = {
      success: true,
      data: suggestions,
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('rebalance-suggestions', error);
  }
}
