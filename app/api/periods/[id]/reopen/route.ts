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
 * Back in OPEN the blocks of part-time patterns and absences are brought
 * up to date again (they only follow changes while a period is OPEN), and
 * the frozen deelnamefactoren go: the next generation freezes new ones.
 * A period that has started cannot be reopened: the first days are being
 * worked, preferences for them mean nothing any more.
 *
 * Not from GEPUBLICEERD: participants have seen that roster, so it is
 * withdrawn first (unpublish), which tells them.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { trashedPeriodDenial } from '@/lib/periodTrash';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { periodStatusLabel } from '@/lib/statusLabels';
import { clearSolverAssignments } from '@/lib/rosterGaps';
import { clearPendingUndo } from '@/lib/pendingUndo';
import { wisBevrorenFactoren } from '@/lib/deelnamefactor';
import { localIsoDate } from '@/lib/localDate';
import { syncAvailabilityForPeriod as syncParttimeAvailability } from '@/lib/parttimeSync';
import { syncAvailabilityForPeriod as syncAbsenceAvailability } from '@/lib/absenceSync';
import type { ApiErrorResponse, ApiSuccessResponse } from '@/types';

const REOPENABLE = ['GESLOTEN', 'GEGENEREERD'];

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

    const period = db
      .prepare('SELECT status, start_datum FROM dienstrooster_schedule_period WHERE id = ? AND verwijderd_op IS NULL')
      .get(id) as { status: string; start_datum: string } | undefined;
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

    if (period.start_datum <= localIsoDate()) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PERIOD_STARTED',
          message: 'De periode is al begonnen en kan niet meer terug naar open.',
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
      wisBevrorenFactoren(id);
      db.prepare(
        `UPDATE dienstrooster_schedule_period SET status = 'OPEN', row_version = row_version + 1 WHERE id = ?`
      ).run(id);
      // Only follow changes while OPEN, so catch up now that it is.
      syncParttimeAvailability(id);
      syncAbsenceAvailability(id);
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
