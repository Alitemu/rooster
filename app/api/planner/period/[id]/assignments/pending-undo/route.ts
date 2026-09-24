/**
 * GET /api/planner/period/[id]/assignments/pending-undo
 *
 * The single most recent reversible manual assign/reassign/remove for this
 * period, if any - see lib/pendingUndo.ts. Returns { pending: null } when
 * there is nothing to undo (never seeded, already undone, or superseded).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { getPendingUndo } from '@/lib/pendingUndo';
import type { ApiSuccessResponse } from '@/types';

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const row = getPendingUndo(params.id);

    const response: ApiSuccessResponse<{ pending: { label: string; onderdeel: string } | null }> = {
      success: true,
      data: { pending: row ? { label: row.label, onderdeel: row.onderdeel } : null },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('assignments-pending-undo', error);
  }
}
