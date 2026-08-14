/**
 * Pool Members Route
 *
 * GET /api/planner/pool/[id]/members - List all active members of a pool
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse } from '@/types';

interface PoolMember {
  person_id: string;
  codenaam: string;
  geldig_van: string;
  geldig_tot: string | null;
  is_active: boolean;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const poolId = params.id;
    const today = new Date().toISOString().split('T')[0];

    const membersStmt = db.prepare(`
      SELECT
        pm.person_id,
        p.codenaam,
        pm.geldig_van,
        pm.geldig_tot,
        CASE
          WHEN pm.geldig_van <= ? AND (pm.geldig_tot IS NULL OR pm.geldig_tot >= ?)
          THEN 1
          ELSE 0
        END as is_active
      FROM dienstrooster_pool_membership pm
      JOIN dienstrooster_person p ON p.id = pm.person_id
      WHERE pm.pool_id = ?
      ORDER BY p.codenaam ASC
    `);

    const members = membersStmt.all(today, today, poolId) as PoolMember[];

    const response: ApiSuccessResponse<PoolMember[]> = {
      success: true,
      data: members,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('planner-pool-members', error);
  }
}
