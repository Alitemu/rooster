/**
 * POST /api/planner/pool/[id]/members/undo-last
 *
 * Reverses the single most recently removed membership for this pool - see
 * lib/pendingUndo.ts. Re-creates the exact same person/date-range/
 * row, but only if nothing has since given this person an
 * overlapping membership in this pool (the same check POST .../members
 * itself already applies to a brand new membership) - otherwise this is
 * refused instead of silently creating a second, overlapping row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { syncAbsencesForPerson } from '@/lib/absenceSync';
import { syncPatternsForPerson } from '@/lib/parttimeSync';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { personHasOtherDienst, poolDienstDenial } from '@/lib/dienstAccess';
import { syncAiosPersoon } from '@/lib/aiosSync';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { getPendingUndo, clearPendingUndo } from '@/lib/pendingUndo';
import type { ApiErrorResponse, ApiSuccessResponse } from '@/types';

interface UndoPayload {
  person_id: string;
  pool_id: string;
  geldig_vanaf: string;
  geldig_tot: string;
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
    const otherDienst = poolDienstDenial(auth, params.id);
    if (otherDienst) return otherDienst;

    const poolId = params.id;
    const pending = getPendingUndo(poolId);
    if (!pending || pending.scope !== 'POOL_MEMBERSHIP') {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'NOTHING_TO_UNDO', message: 'Ongedaan maken kan alleen direct na de wijziging. Pas het zo nodig met de hand aan.' },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const payload = JSON.parse(pending.payload_json) as UndoPayload;

    const pool = db.prepare('SELECT type FROM dienstrooster_pool WHERE id = ?').get(poolId) as { type: string } | undefined;
    const applied = db.transaction((): boolean | 'ANDERE_DIENST' => {
      // Between the removal and this undo the other dienst may have taken the person over: never into both.
      if (pool && personHasOtherDienst(payload.person_id, pool.type)) return 'ANDERE_DIENST';
      const overlapping = db
        .prepare(
          `SELECT id FROM dienstrooster_pool_membership
           WHERE pool_id = ? AND person_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
        )
        .get(poolId, payload.person_id, payload.geldig_tot, payload.geldig_vanaf);
      if (overlapping) return false;

      const membershipId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
         VALUES (?, ?, ?, 1.0, ?, ?)`
      ).run(membershipId, payload.person_id, poolId, payload.geldig_vanaf, payload.geldig_tot);
      writeAuditLog({
        actorId: auth!.userId,
        entiteit: 'pool_membership',
        entiteitId: membershipId,
        actie: 'CREATE',
        nieuw: { wijziging: 'verwijderen ongedaan gemaakt', ...payload },
      });
      return true;
    })();

    if (applied === 'ANDERE_DIENST') {
      clearPendingUndo(poolId);
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'UNDO_STALE', message: 'Deze verwijdering kan niet meer ongedaan gemaakt worden.' },
      };
      return NextResponse.json(response, { status: 409 });
    }
    if (!applied) {
      clearPendingUndo(poolId);
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'UNDO_STALE',
          message: 'Deze verwijdering kan niet meer ongedaan gemaakt worden, omdat deze persoon intussen alweer een lidmaatschap in deze periode heeft.',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    clearPendingUndo(poolId);
    // Same backfill as adding a member - see members/route.ts.
    syncAbsencesForPerson(payload.person_id);
    syncPatternsForPerson(payload.person_id);
    // The AIOS's own sync for an AIOS pool (lib/aiosSync.ts), as when adding a member.
    syncAiosPersoon(payload.person_id);
    const response: ApiSuccessResponse<{ undone: true; label: string }> = {
      success: true,
      data: { undone: true, label: pending.label },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('pool-members-undo-last', error);
  }
}
