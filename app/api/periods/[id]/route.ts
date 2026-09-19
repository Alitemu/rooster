/**
 * Period Detail API Route
 *
 * GET    /api/periods/[id]  - Get detailed period information
 * DELETE /api/periods/[id]  - Move a period to the trash (soft-delete)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { softDeletePeriod, PeriodTrashError } from '@/lib/periodTrash';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface PeriodDetail {
  id: string;
  pool_id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
  bevroren_ruleset_json: string | null;
  overloop_bevestigd_op: string | null;
  gepubliceerd_op: string | null;
  row_version: number;
  verwijderd_op: string | null;
}

/**
 * What a participant gets back: exactly the fields app/person/[token]
 * renders (period name, dates, deadline and status), and nothing else.
 */
type ParticipantPeriodView = Pick<
  PeriodDetail,
  'id' | 'naam' | 'start_datum' | 'eind_datum' | 'deadline' | 'status'
>;

/**
 * True when this participant belongs to the period: either they hold an
 * access link issued for it, or they are a member of its pool for dates
 * that overlap it.
 *
 * Both count, and neither alone is enough. The link is what an invitation
 * mail gives them, and it keeps working for a period they have since left
 * the pool for - they still need to read the roster they are in. Pool
 * membership covers the other direction: someone added to the pool while a
 * period is already open, before any link has been exported for them.
 */
function isPeriodVisibleToPerson(personId: string, period: PeriodDetail): boolean {
  const viaLink = db
    .prepare(
      `SELECT 1 FROM dienstrooster_person_access_link
       WHERE person_id = ? AND geldt_voor_periode_id = ? AND ingetrokken_op IS NULL
       LIMIT 1`
    )
    .get(personId, period.id);
  if (viaLink) return true;

  const viaMembership = db
    .prepare(
      `SELECT 1 FROM dienstrooster_pool_membership
       WHERE person_id = ? AND pool_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?
       LIMIT 1`
    )
    .get(personId, period.pool_id, period.eind_datum, period.start_datum);
  return Boolean(viaMembership);
}

/**
 * GET /api/periods/[id] - Get period details
 *
 * Returns full period information including frozen ruleset and confirmation status
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    // Both staff and any authenticated person need this: the person page
    // reads their own current period's name/dates/status through it.
    const auth = getAuthContextFromRequest(req);
    if (!auth) {
      return unauthorizedResponse();
    }

    const { id } = params;

    // Validate ID format
    if (!id || typeof id !== 'string') {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_PERIOD_ID',
          message: 'Periode-ID moet een geldige tekenreeks zijn',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const stmt = db.prepare(`
      SELECT
        id,
        pool_id,
        naam,
        start_datum,
        eind_datum,
        deadline,
        status,
        bevroren_ruleset_json,
        overloop_bevestigd_op,
        gepubliceerd_op,
        row_version,
        verwijderd_op
      FROM dienstrooster_schedule_period
      WHERE id = ?
    `);

    const row = stmt.get(id) as PeriodDetail | undefined;

    if (!row) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PERIOD_NOT_FOUND',
          message: `Periode met ID ${id} niet gevonden`,
        },
      };
      return NextResponse.json(response, { status: 404 });
    }

    if (!requirePlannerAccess(auth)) {
      // A participant may only see a period they are actually part of, and
      // only the part of it their own page renders. Without this, any
      // participant could read every period in the database by id -
      // including the frozen ruleset, which spells out the solver's
      // penalties and budgets and so amounts to a description of how to
      // game one's own preferences.
      if (!isPeriodVisibleToPerson(auth!.userId, row)) {
        const response: ApiErrorResponse = {
          success: false,
          error: {
            code: 'PERIOD_NOT_FOUND',
            message: `Periode met ID ${id} niet gevonden`,
          },
        };
        return NextResponse.json(response, { status: 404 });
      }

      const response: ApiSuccessResponse<ParticipantPeriodView> = {
        success: true,
        data: {
          id: row.id,
          naam: row.naam,
          start_datum: row.start_datum,
          eind_datum: row.eind_datum,
          deadline: row.deadline,
          status: row.status,
        },
      };
      return NextResponse.json(response);
    }

    const response: ApiSuccessResponse<PeriodDetail> = {
      success: true,
      data: row,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-detail', error);
  }
}

/**
 * DELETE /api/periods/[id] - Move a period to the trash
 *
 * Soft-delete only: the period is recoverable via POST .../restore for
 * RETENTION_DAYS, after which it is purged automatically. Use
 * POST .../purge to skip the wait and delete it permanently right away.
 */
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;

    try {
      softDeletePeriod(id, auth!.userId);
    } catch (error) {
      if (error instanceof PeriodTrashError) {
        const status = error.code === 'NOT_FOUND' ? 404 : 409;
        const response: ApiErrorResponse = {
          success: false,
          error: { code: error.code, message: error.message },
        };
        return NextResponse.json(response, { status });
      }
      throw error;
    }

    const response: ApiSuccessResponse<{ deleted: boolean }> = {
      success: true,
      data: { deleted: true },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-delete', error);
  }
}
