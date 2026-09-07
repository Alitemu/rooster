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
  actief: boolean;
  member_count: number;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    // Inactive pools are excluded by default - a deactivated pool
    // shouldn't be offered as a place to open a new period. Pass
    // ?include_inactive=true to see everything (e.g. an admin screen
    // managing pools themselves, not just picking one for a period).
    const includeInactive = req.nextUrl.searchParams.get('include_inactive') === 'true';

    const poolsStmt = db.prepare(`
      SELECT
        p.id,
        p.naam,
        p.type,
        p.actief,
        COUNT(pm.person_id) as member_count
      FROM dienstrooster_pool p
      LEFT JOIN dienstrooster_pool_membership pm ON p.id = pm.pool_id
      ${includeInactive ? '' : 'WHERE p.actief = 1'}
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
