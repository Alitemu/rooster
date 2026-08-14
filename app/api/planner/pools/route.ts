/**
 * Pools List Route
 *
 * GET /api/planner/pools - List all available pools
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse } from '@/types';

interface Pool {
  id: string;
  naam: string;
  type: string;
  member_count: number;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const poolsStmt = db.prepare(`
      SELECT
        p.id,
        p.naam,
        p.type,
        COUNT(pm.person_id) as member_count
      FROM dienstrooster_pool p
      LEFT JOIN dienstrooster_pool_membership pm ON p.id = pm.pool_id
      GROUP BY p.id
      ORDER BY p.naam ASC
    `);

    const pools = poolsStmt.all() as Pool[];

    const response: ApiSuccessResponse<Pool[]> = {
      success: true,
      data: pools,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('planner-pools-list', error);
  }
}
