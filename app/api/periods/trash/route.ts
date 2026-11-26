/**
 * GET /api/periods/trash - List periods currently in the trash
 *
 * Sweeps expired entries (past their retention window) first, so the list
 * never shows something that's about to disappear on the next page load
 * anyway.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { visibleDienst } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { purgeExpiredPeriods, listTrash, type TrashedPeriod } from '@/lib/periodTrash';
import type { ApiSuccessResponse } from '@/types';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    purgeExpiredPeriods(auth!.userId, visibleDienst(auth!));

    const response: ApiSuccessResponse<TrashedPeriod[]> = {
      success: true,
      data: listTrash(visibleDienst(auth!)),
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('periods-trash-list', error);
  }
}
