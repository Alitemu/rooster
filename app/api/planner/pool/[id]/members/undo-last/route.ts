/**
 * POST /api/planner/pool/[id]/members/undo-last
 *
 * Reverses the single most recently removed membership for this pool - see
 * lib/pendingUndo.ts. Re-creates the exact same person/date-range/
 * deelnamefactor row, but only if nothing has since given this person an
 * overlapping membership in this pool (the same check POST .../members
 * itself already applies to a brand new membership) - otherwise this is
 * refused instead of silently creating a second, overlapping row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { syncAbsencesForPerson } from '@/lib/absenceSync';
import { syncPatternsForPerson } from '@/lib/parttimeSync';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { getPendingUndo, clearPendingUndo } from '@/lib/pendingUndo';
import type { ApiErrorResponse, ApiSuccessResponse } from '@/types';

interface UndoPayload {
  person_id: string;
  pool_id: string;
  geldig_vanaf: string;
  geldig_tot: string;
  deelnamefactor: number;
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const poolId = params.id;
    const pending = getPendingUndo(poolId);
    if (!pending || pending.scope !== 'POOL_MEMBERSHIP') {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'NOTHING_TO_UNDO', message: 'Er is niets meer om ongedaan te maken' },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const payload = JSON.parse(pending.payload_json) as UndoPayload;

    const applied = db.transaction((): boolean => {
      const overlapping = db
        .prepare(
          `SELECT id FROM dienstrooster_pool_membership
           WHERE pool_id = ? AND person_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
        )
        .get(poolId, payload.person_id, payload.geldig_tot, payload.geldig_vanaf);
      if (overlapping) return false;

      db.prepare(
        `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(crypto.randomUUID(), payload.person_id, poolId, payload.deelnamefactor, payload.geldig_vanaf, payload.geldig_tot);
      return true;
    })();

    if (!applied) {
      clearPendingUndo(poolId);
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'UNDO_STALE',
          message: 'Deze verwijdering kan niet meer ongedaan gemaakt worden - deze persoon heeft intussen alweer een lidmaatschap in deze periode.',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    clearPendingUndo(poolId);
    // Same backfill as adding a member - see members/route.ts.
    syncAbsencesForPerson(payload.person_id);
    syncPatternsForPerson(payload.person_id);
    const response: ApiSuccessResponse<{ undone: true; label: string }> = {
      success: true,
      data: { undone: true, label: pending.label },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('pool-members-undo-last', error);
  }
}
