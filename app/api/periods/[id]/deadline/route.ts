/**
 * PATCH /api/periods/[id]/deadline - Adjust an open period's deadline
 *
 * The only place a planner can still move the deadline after opening a
 * period - there's no such control at creation-or-later otherwise. Every
 * participant-facing route that touches preferences (slot toggles,
 * part-time patterns, submission) checks this same column live via
 * lib/periodInputGate.ts, so a change here takes effect for them
 * immediately - there's no separate "old deadline" to fall out of sync
 * with, because nothing ever copies the value anywhere else.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface UpdateDeadlineRequest {
  deadline: string;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;
    const body = (await parseJsonBody(req)) as UpdateDeadlineRequest;

    if (!body.deadline) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'MISSING_DEADLINE', message: 'Deadline is verplicht' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const period = db
      .prepare('SELECT id, status, start_datum FROM dienstrooster_schedule_period WHERE id = ?')
      .get(id) as { id: string; status: string; start_datum: string } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Only meaningful while the period is still collecting input - once
    // it's closed (or beyond), the deadline that mattered has already had
    // its effect, and moving it wouldn't reopen anything (see
    // lib/periodInputGate.ts, which gates on status too, not just the
    // deadline).
    if (period.status !== 'OPEN') {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Deadline kan niet aangepast worden in status ${period.status}`,
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const deadline = new Date(body.deadline);
    if (isNaN(deadline.getTime())) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_DEADLINE', message: 'Ongeldige deadline' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Same two rules the wizard already enforces when the deadline is
    // first set, so a planner can't back themselves into the exact
    // confusing states those checks exist to prevent.
    if (deadline < new Date()) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_DEADLINE', message: 'Deadline mag niet in het verleden liggen' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (deadline >= new Date(period.start_datum)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_DEADLINE', message: 'Deadline moet vóór de startdatum liggen' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    db.prepare('UPDATE dienstrooster_schedule_period SET deadline = ? WHERE id = ?').run(
      body.deadline,
      id
    );

    const response: ApiSuccessResponse<{ deadline: string }> = {
      success: true,
      data: { deadline: body.deadline },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-deadline-update', error);
  }
}
