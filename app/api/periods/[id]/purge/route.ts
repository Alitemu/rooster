/**
 * POST /api/periods/[id]/purge - Permanently delete a period right now
 *
 * Only allowed on a period already in the trash (verwijderd_op set) - the
 * trash is the one path to permanent deletion, so a planner always passes
 * through the recoverable state first. Irreversible: everything scoped to
 * the period (slots, assignments, availability, submissions, ledger
 * entries, ...) is gone after this.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { purgePeriodNow, PeriodTrashError } from '@/lib/periodTrash';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

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

    try {
      purgePeriodNow(id, auth!.userId);
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

    const response: ApiSuccessResponse<{ purged: boolean }> = {
      success: true,
      data: { purged: true },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-purge', error);
  }
}
