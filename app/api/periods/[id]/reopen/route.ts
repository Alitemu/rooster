/**
 * POST /api/periods/[id]/reopen - back to OPEN from GESLOTEN or GEGENEREERD
 *
 * Preferences can be changed again (until the deadline, which the planner
 * can move once the period is OPEN). From GEGENEREERD the solver's roster
 * goes: it was built on preferences that are about to change, and the next
 * generation replaces it anyway. What a planner put in by hand (MANUAL and
 * OVERRIDE rows: "Rooster vooraf invullen" and every correction to the
 * generated roster) stays, exactly as a regeneration keeps it. The pending
 * undo goes too, as it may point at a solver row that is gone.
 *
 * Not from GEPUBLICEERD: participants have seen that roster, so it is
 * withdrawn first (unpublish), which tells them.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { periodStatusLabel } from '@/lib/statusLabels';
import { clearSolverAssignments } from '@/lib/rosterGaps';
import { clearPendingUndo } from '@/lib/pendingUndo';
import type { ApiErrorResponse, ApiSuccessResponse } from '@/types';

const REOPENABLE = ['GESLOTEN', 'GEGENEREERD'];

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();

    const period = db
      .prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ? AND verwijderd_op IS NULL')
      .get(id) as { status: string } | undefined;
    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' },
      };
      return NextResponse.json(response, { status: 404 });
    }
    if (!REOPENABLE.includes(period.status)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message:
            period.status === 'GEPUBLICEERD'
              ? 'Trek eerst de publicatie in. Daarna kan de periode terug naar open.'
              : `Periode kan niet terug naar open vanuit status "${periodStatusLabel(period.status)}"`,
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    let verwijderd = 0;
    db.transaction(() => {
      if (period.status === 'GEGENEREERD') {
        verwijderd = clearSolverAssignments(id);
        clearPendingUndo(id);
      }
      db.prepare(
        `UPDATE dienstrooster_schedule_period SET status = 'OPEN', row_version = row_version + 1 WHERE id = ?`
      ).run(id);
      db.prepare(
        `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
         VALUES (?, ?, 'schedule_period', ?, 'UPDATE', ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        auth!.userId,
        id,
        JSON.stringify({ status: period.status }),
        JSON.stringify({ status: 'OPEN', wijziging: 'terug naar open', solver_diensten_verwijderd: verwijderd }),
        new Date().toISOString()
      );
    })();

    const response: ApiSuccessResponse<{ status: string; verwijderd: number }> = {
      success: true,
      data: { status: 'OPEN', verwijderd },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('reopen-period', error);
  }
}
