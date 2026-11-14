/**
 * POST /api/periods/[id]/reset-roster - remove the generated roster
 *
 * From GEGENEREERD back to GESLOTEN: the solver's shifts go and the period
 * is ready to be generated afresh, with the preferences still closed ("Terug
 * naar open" is the way to reopen those). With `ook_handmatig: true` the
 * shifts a planner put in by hand go as well (MANUAL and OVERRIDE rows:
 * "Rooster vooraf invullen" and every correction), for a clean start;
 * without it they stay, as a regeneration keeps them. The pending undo goes
 * either way, as it may point at a row that is gone.
 *
 * Not from GEPUBLICEERD: participants have seen that roster, so it is
 * withdrawn first (unpublish), which tells them. Not while a generation
 * runs: it would write its roster over the reset.
 */

import { NextRequest, NextResponse } from 'next/server';
import { wisBevrorenFactoren } from '@/lib/deelnamefactor';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { trashedPeriodDenial } from '@/lib/periodTrash';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { badRequest } from '@/lib/requestFields';
import { clearSolverAssignments } from '@/lib/rosterGaps';
import { clearPendingUndo } from '@/lib/pendingUndo';
import { hasRunningJobForPeriod } from '@/lib/rosterGenerationJobs';
import { writeAuditLog } from '@/lib/auditLog';
import type { ApiErrorResponse, ApiSuccessResponse } from '@/types';

function conflict(code: string, message: string): NextResponse {
  const response: ApiErrorResponse = { success: false, error: { code, message } };
  return NextResponse.json(response, { status: 409 });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    // The achterwacht's step; the AIOS's comes later (lib/aiosPeriod.ts).
    const aiosNotYet = aiosNotYetDenial(id);
    if (aiosNotYet) return aiosNotYet;
    // Nothing changes in the prullenbak (lib/periodTrash.ts).
    const inTrash = trashedPeriodDenial(id);
    if (inTrash) return inTrash;

    const body = await parseJsonBody(req);
    const ookHandmatig = body.ook_handmatig ?? false;
    if (typeof ookHandmatig !== 'boolean') {
      return badRequest('INVALID_INPUT', 'Kies of ook de handmatig ingevulde diensten weg moeten');
    }

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
    if (period.status === 'GEPUBLICEERD') {
      return conflict('INVALID_STATUS', 'Trek eerst de publicatie in. Daarna kun je het rooster verwijderen.');
    }
    if (period.status !== 'GEGENEREERD') {
      return conflict('INVALID_STATUS', 'Er is geen gegenereerd rooster om te verwijderen.');
    }
    if (hasRunningJobForPeriod(id)) {
      return conflict('GENERATION_RUNNING', 'Er loopt nog een roostergeneratie. Wacht tot die klaar is of annuleer hem eerst.');
    }

    const result = db.transaction(() => {
      const solver = clearSolverAssignments(id);
      const handmatig = ookHandmatig
        ? db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(id).changes
        : 0;
      clearPendingUndo(id);
      // The factors held with the roster go with it (lib/deelnamefactor.ts).
      wisBevrorenFactoren(id);
      db.prepare(
        `UPDATE dienstrooster_schedule_period SET status = 'GESLOTEN', row_version = row_version + 1 WHERE id = ?`
      ).run(id);
      writeAuditLog({
        actorId: auth!.userId,
        entiteit: 'schedule_period',
        entiteitId: id,
        actie: 'DELETE',
        oud: { status: 'GEGENEREERD' },
        nieuw: { status: 'GESLOTEN', wijziging: 'rooster verwijderd', solver_diensten_verwijderd: solver, handmatige_diensten_verwijderd: handmatig },
      });
      return { solver, handmatig };
    })();

    const response: ApiSuccessResponse<{ status: string; verwijderd: number; handmatig_verwijderd: number }> = {
      success: true,
      data: { status: 'GESLOTEN', verwijderd: result.solver + result.handmatig, handmatig_verwijderd: result.handmatig },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('reset-roster', error);
  }
}
