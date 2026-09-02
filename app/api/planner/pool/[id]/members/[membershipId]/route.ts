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
}

function getMembership(poolId: string, membershipId: string) {
  return db
    .prepare(
      `SELECT id, geldig_vanaf, geldig_tot FROM dienstrooster_pool_membership
       WHERE id = ? AND pool_id = ?`
    )
    .get(membershipId, poolId) as { id: string; geldig_vanaf: string; geldig_tot: string } | undefined;
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

    if (!body.geldig_vanaf && !body.geldig_tot) {
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

    db.prepare(
      `UPDATE dienstrooster_pool_membership SET geldig_vanaf = ?, geldig_tot = ? WHERE id = ?`
    ).run(geldig_vanaf, geldig_tot, membershipId);

    const response: ApiSuccessResponse<{ id: string; geldig_vanaf: string; geldig_tot: string }> = {
      success: true,
      data: { id: membershipId, geldig_vanaf, geldig_tot },
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
