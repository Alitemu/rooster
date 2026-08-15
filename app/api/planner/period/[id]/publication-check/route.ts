/**
 * GET /api/planner/period/[id]/publication-check
 *
 * Validate that a roster is ready for publication: every slot filled, no
 * ABSOLUUT violations, everyone inside their band.
 *
 * The logic lives in lib/publicationCheck so the publish route enforces the
 * exact same rules rather than trusting the dialog to have run this first.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { runPublicationCheck } from '@/lib/publicationCheck';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = getAuthContextFromRequest(_request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const period = db
      .prepare(
        `SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json
         FROM dienstrooster_schedule_period WHERE id = ?`
      )
      .get(params.id) as
      | {
          id: string;
          pool_id: string;
          start_datum: string;
          eind_datum: string;
          bevroren_ruleset_json: string | null;
        }
      | undefined;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Period not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, data: runPublicationCheck(period) });
  } catch (error) {
    return internalErrorResponse('publication-check', error);
  }
}
