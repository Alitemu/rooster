/**
 * Pool Member Detail Route
 *
 * PATCH  /api/planner/pool/[id]/members/[membershipId] - Change a
 * membership's date range (e.g. end someone's participation early on
 * contract end, or extend it)
 * DELETE /api/planner/pool/[id]/members/[membershipId] - Remove the
 * membership row entirely
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface UpdateMembershipRequest {
  geldig_vanaf?: string;
  geldig_tot?: string;
  deelnamefactor?: number;
}

/** 0 excluded (no participation at all isn't a membership) - 1 is full-time. */
function isValidDeelnamefactor(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
}

function getMembership(poolId: string, membershipId: string) {
  return db
    .prepare(
      `SELECT id, person_id, geldig_vanaf, geldig_tot, deelnamefactor FROM dienstrooster_pool_membership
       WHERE id = ? AND pool_id = ?`
    )
    .get(membershipId, poolId) as
    | { id: string; person_id: string; geldig_vanaf: string; geldig_tot: string; deelnamefactor: number }
    | undefined;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; membershipId: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id: poolId, membershipId } = params;
    const body = (await parseJsonBody(req)) as UpdateMembershipRequest;

    const membership = getMembership(poolId, membershipId);
    if (!membership) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'MEMBERSHIP_NOT_FOUND', message: `Membership ${membershipId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const geldig_vanaf = body.geldig_vanaf || membership.geldig_vanaf;
    const geldig_tot = body.geldig_tot || membership.geldig_tot;
    const deelnamefactor = body.deelnamefactor ?? membership.deelnamefactor;

    if (!body.geldig_vanaf && !body.geldig_tot && body.deelnamefactor === undefined) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'NO_UPDATES', message: 'Geen velden om bij te werken' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (geldig_vanaf > geldig_tot) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_RANGE', message: '"Geldig vanaf" moet vóór of op "geldig tot" liggen' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (body.deelnamefactor !== undefined && !isValidDeelnamefactor(deelnamefactor)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_DEELNAMEFACTOR', message: 'Deelnamefactor moet tussen 0 (exclusief) en 1 liggen' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Same overlap rule as creating a new membership - see members/route.ts.
    const overlapping = db
      .prepare(
        `SELECT id FROM dienstrooster_pool_membership
         WHERE pool_id = ? AND person_id = ? AND id != ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
      )
      .get(poolId, membership.person_id, membershipId, geldig_tot, geldig_vanaf);
    if (overlapping) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MEMBERSHIP_OVERLAP',
          message: 'Deze persoon heeft in deze pool al een lidmaatschap dat deze periode overlapt',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    db.prepare(
      `UPDATE dienstrooster_pool_membership SET geldig_vanaf = ?, geldig_tot = ?, deelnamefactor = ? WHERE id = ?`
    ).run(geldig_vanaf, geldig_tot, deelnamefactor, membershipId);

    const response: ApiSuccessResponse<{ id: string; geldig_vanaf: string; geldig_tot: string; deelnamefactor: number }> = {
      success: true,
      data: { id: membershipId, geldig_vanaf, geldig_tot, deelnamefactor },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('planner-pool-member-update', error);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; membershipId: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id: poolId, membershipId } = params;

    const membership = getMembership(poolId, membershipId);
    if (!membership) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'MEMBERSHIP_NOT_FOUND', message: `Membership ${membershipId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE id = ?').run(membershipId);

    const response: ApiSuccessResponse<{ deleted: boolean }> = {
      success: true,
      data: { deleted: true },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('planner-pool-member-delete', error);
  }
}
