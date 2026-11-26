/**
 * GET /api/planner/period/[id]/assignments/pending-undo
 *
 * The single most recent reversible manual assign/reassign/remove for this
 * period, if any - see lib/pendingUndo.ts. Returns { pending: null } when
 * there is nothing to undo (never seeded, already undone, superseded or
 * past its two minutes). The page asks for it after a change of its own,
 * never when it opens.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { getPendingUndo, undoVerlooptOver } from '@/lib/pendingUndo';
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
    const otherDienst = periodDienstDenial(auth, params.id);
    if (otherDienst) return otherDienst;

    const row = getPendingUndo(params.id);

    const response: ApiSuccessResponse<{ pending: { id: string; label: string; onderdeel: string; verloopt_over_seconden: number } | null }> = {
      success: true,
      data: { pending: row ? { id: row.id, label: row.label, onderdeel: row.onderdeel, verloopt_over_seconden: undoVerlooptOver(row) } : null },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('assignments-pending-undo', error);
  }
}
