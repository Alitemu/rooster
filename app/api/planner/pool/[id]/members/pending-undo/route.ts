/**
 * GET /api/planner/pool/[id]/members/pending-undo
 *
 * The single most recent reversible membership removal for this pool, if
 * any - see lib/pendingUndo.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { poolDienstDenial } from '@/lib/dienstAccess';
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
    const otherDienst = poolDienstDenial(auth, params.id);
    if (otherDienst) return otherDienst;

    const row = getPendingUndo(params.id);
    const response: ApiSuccessResponse<{ pending: { id: string; label: string; verloopt_over_seconden: number } | null }> = {
      success: true,
      data: { pending: row && row.scope === 'POOL_MEMBERSHIP' ? { id: row.id, label: row.label, verloopt_over_seconden: undoVerlooptOver(row) } : null },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('pool-members-pending-undo', error);
  }
}
