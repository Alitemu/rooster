/**
 * Planner Period Management Route
 *
 * POST /api/planner/periods - Create new period for planner
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { isValidIsoDate } from '@/lib/isoDate';
import { parseISO } from '@/lib/holidays';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface CreatePeriodRequest {
  naam: string;
  pool_id: string;
  start_datum: string; // ISO-8601
  eind_datum: string; // ISO-8601
  deadline: string; // ISO-8601
}

interface CreatePeriodResponse {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
  pool_id: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const body = await parseJsonBody<CreatePeriodRequest>(req);

    if (!body.naam || !body.pool_id || !body.start_datum || !body.eind_datum || !body.deadline) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_FIELDS',
          message: 'Verplichte velden ontbreken: naam, pool_id, start_datum, eind_datum, deadline',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Validate dates.
    //
    // start/eind are date-only strings and must be checked against that
    // exact shape: `new Date()` alone accepted plenty that is not one.
    // "04-01-2027" was read as 4 January in Dutch order but parsed as 1
    // April, and "2027" as 1 January 2027 - both stored without complaint
    // and both wrong in a way nothing downstream could notice.
    if (!isValidIsoDate(body.start_datum) || !isValidIsoDate(body.eind_datum)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_DATE',
          message: 'Ongeldige datumnotatie. Gebruik ISO-8601 (JJJJ-MM-DD)',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // parseISO, not `new Date(...)`: a bare date-only string is parsed as
    // UTC midnight, which in Europe/Amsterdam is 01:00 or 02:00 that same
    // morning. Comparing that against the deadline (a real timestamp) let
    // a deadline of 00:30 on the period's own start day pass the "deadline
    // must be before the start" check below. parseISO gives local midnight,
    // which is what both of those rules are actually about.
    const start = parseISO(body.start_datum);
    const end = parseISO(body.eind_datum);
    const deadline = new Date(body.deadline);

    if (isNaN(deadline.getTime())) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_DATE',
          message: 'Ongeldige datumnotatie. Gebruik ISO-8601 (JJJJ-MM-DD)',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (start >= end) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_PERIOD',
          message: 'Startdatum moet vóór einddatum liggen',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (deadline < new Date()) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_DEADLINE',
          message: 'Deadline mag niet in het verleden liggen',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (deadline >= start) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_DEADLINE',
          message: 'Deadline moet vóór de startdatum liggen',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Create period
    const insertStmt = db.prepare(`
      INSERT INTO dienstrooster_schedule_period
        (id, naam, pool_id, start_datum, eind_datum, deadline, status, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, 'CONCEPT', ?)
    `);

    const periodId = crypto.randomUUID();
    const now = new Date().toISOString();

    insertStmt.run(periodId, body.naam, body.pool_id, body.start_datum, body.eind_datum, body.deadline, now);

    const response: ApiSuccessResponse<CreatePeriodResponse> = {
      success: true,
      data: {
        id: periodId,
        naam: body.naam,
        start_datum: body.start_datum,
        eind_datum: body.eind_datum,
        deadline: body.deadline,
        status: 'CONCEPT',
        pool_id: body.pool_id,
      },
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    return internalErrorResponse('planner-create-period', error);
  }
}
