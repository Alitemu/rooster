/**
 * POST /api/periods/[id]/restore - Recover a period from the trash
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { restorePeriod, PeriodTrashError } from '@/lib/periodTrash';
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
      restorePeriod(id, auth!.userId);
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

    const response: ApiSuccessResponse<{ restored: boolean }> = {
      success: true,
      data: { restored: true },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-restore', error);
  }
}
