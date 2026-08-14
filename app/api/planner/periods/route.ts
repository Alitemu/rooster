/**
 * Planner Period Management Route
 *
 * POST /api/planner/periods - Create new period for planner
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
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

    const body: CreatePeriodRequest = await req.json();

    if (!body.naam || !body.pool_id || !body.start_datum || !body.eind_datum || !body.deadline) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_FIELDS',
          message: 'Missing required fields: naam, pool_id, start_datum, eind_datum, deadline',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Validate dates
    const start = new Date(body.start_datum);
    const end = new Date(body.eind_datum);
    const deadline = new Date(body.deadline);

    if (isNaN(start.getTime()) || isNaN(end.getTime()) || isNaN(deadline.getTime())) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_DATE',
          message: 'Invalid date format. Use ISO-8601 (YYYY-MM-DD)',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (start >= end) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_PERIOD',
          message: 'Start date must be before end date',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (deadline > end) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_DEADLINE',
          message: 'Deadline must be before or on end date',
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
