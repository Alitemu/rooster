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
  rowVersion?: number;
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
      .prepare('SELECT id, status, start_datum, row_version FROM dienstrooster_schedule_period WHERE id = ?')
      .get(id) as { id: string; status: string; start_datum: string; row_version: number } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${id} niet gevonden` },
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

    // Optimistic locking, same as ruleset/route.ts - without this, two
    // planners editing the deadline and the ruleset concurrently got
    // inconsistent conflict protection depending on which route they hit.
    if (body.rowVersion !== undefined && body.rowVersion !== period.row_version) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'ROW_VERSION_CONFLICT',
          message: 'Deze periode is intussen door iemand anders aangepast. Laad de pagina opnieuw en probeer het nog eens.',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    let sql = 'UPDATE dienstrooster_schedule_period SET deadline = ?, row_version = row_version + 1 WHERE id = ?';
    const sqlParams: unknown[] = [body.deadline, id];
    // Folding rowVersion into the UPDATE's own WHERE clause (rather than
    // only comparing it above) closes the race window between that check
    // and this write - see ruleset/route.ts for the same reasoning.
    if (body.rowVersion !== undefined) {
      sql += ' AND row_version = ?';
      sqlParams.push(body.rowVersion);
    }

    const info = db.prepare(sql).run(...sqlParams);

    if (info.changes === 0) {
      // Distinguish "the row was deleted in the meantime" from a genuine
      // version conflict - see ruleset/route.ts for the same reasoning.
      const stillExists = db.prepare('SELECT 1 FROM dienstrooster_schedule_period WHERE id = ?').get(id);
      if (!stillExists) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${id} niet gevonden` },
        };
        return NextResponse.json(response, { status: 404 });
      }

      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'ROW_VERSION_CONFLICT',
          message: 'Deze periode is intussen door iemand anders aangepast. Laad de pagina opnieuw en probeer het nog eens.',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    // Re-read rather than compute (period.row_version + 1) - when
    // rowVersion was omitted, the UPDATE has no version guard, so the
    // pre-fetch value could already be stale by the time this responds.
    const freshRowVersion = (
      db.prepare('SELECT row_version FROM dienstrooster_schedule_period WHERE id = ?').get(id) as { row_version: number }
    ).row_version;

    const response: ApiSuccessResponse<{ deadline: string; row_version: number }> = {
      success: true,
      data: { deadline: body.deadline, row_version: freshRowVersion },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-deadline-update', error);
  }
}
